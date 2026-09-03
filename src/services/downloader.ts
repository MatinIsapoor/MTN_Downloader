import { spawn, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { config } from "../config";
import { detectPlatform } from "../utils/platform";

export interface DownloadResult {
  filePath: string;
  fileName: string;
  title?: string;
  ext: string;
  size: number;
  platform: string;
}

export interface DownloadProgress {
  percent?: number;
  speed?: string;
  eta?: string;
}

function ensureDownloadDir(): void {
  if (!fs.existsSync(config.downloadDir)) fs.mkdirSync(config.downloadDir, { recursive: true });
}

function checkYtDlp(): boolean {
  try {
    execSync(`"${config.ytDlpPath}" --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function getYtDlpVersion(): string | null {
  try {
    return execSync(`"${config.ytDlpPath}" --version`, { encoding: "utf8" }).trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

// --- Capability probes (cached) -------------------------------------------

let _hasNodeRuntime: boolean | null = null;
/** yt-dlp can solve YouTube JS challenges / PO-token checks when a JS runtime is available. */
function hasNodeRuntime(): boolean {
  if (_hasNodeRuntime === null) {
    try {
      execSync("node --version", { stdio: "ignore" });
      _hasNodeRuntime = true;
    } catch {
      _hasNodeRuntime = false;
    }
  }
  return _hasNodeRuntime;
}

let _supportsImpersonate: boolean | null = null;
/** --impersonate needs a yt-dlp build with curl_cffi; harmless to probe once and cache. */
function supportsImpersonate(): boolean {
  if (_supportsImpersonate === null) {
    try {
      execSync(`"${config.ytDlpPath}" --impersonate chrome --version`, { stdio: "ignore" });
      _supportsImpersonate = true;
    } catch {
      _supportsImpersonate = false;
    }
  }
  return _supportsImpersonate;
}

function hasCookies(): boolean {
  if (config.cookiesFromBrowser) return true;
  try {
    return fs.existsSync(config.cookiesPath);
  } catch {
    return false;
  }
}

/** Log yt-dlp / cookies / runtime status at startup so the admin sees problems early. */
export function logDownloaderDiagnostics(): void {
  const version = getYtDlpVersion();
  console.log(`🔧 yt-dlp version: ${version ?? "NOT FOUND"}`);
  console.log(
    hasNodeRuntime()
      ? "🔧 JS runtime: node available (YouTube JS challenges enabled)"
      : "⚠️ JS runtime: node NOT found on PATH — YouTube extraction will be degraded"
  );
  console.log(
    supportsImpersonate()
      ? "🔧 Browser impersonation: supported"
      : "⚠️ Browser impersonation: not supported by this yt-dlp build (TikTok may fail more often)"
  );
  if (config.cookiesFromBrowser) {
    console.log(`🔧 Cookies: reading from browser "${config.cookiesFromBrowser}"`);
  } else if (hasCookies()) {
    console.log(`🔧 Cookies: using file ${config.cookiesPath}`);
  } else {
    console.warn(
      `⚠️ No cookies configured (COOKIES_PATH=${config.cookiesPath} not found, COOKIES_FROM_BROWSER empty). ` +
        `YouTube downloads will likely fail with "Sign in to confirm you're not a bot". See README to set up cookies.`
    );
  }
  console.log(
    config.tiktokFallback
      ? "🔧 TikTok fallback API: enabled"
      : "🔧 TikTok fallback API: disabled (TIKTOK_FALLBACK=false)"
  );
}

const AUDIO_EXTENSIONS = new Set(["m4a", "mp3", "ogg", "opus", "wav", "aac", "flac", "wma"]);

const TIKTOK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Extra yt-dlp args derived from local capabilities: auth cookies + JS runtime. */
function buildCommonArgs(): string[] {
  const args: string[] = [];
  if (config.cookiesFromBrowser) {
    args.push("--cookies-from-browser", config.cookiesFromBrowser);
    console.log(`✅ Using cookies from browser: ${config.cookiesFromBrowser}`);
  } else if (fs.existsSync(config.cookiesPath)) {
    args.push("--cookies", config.cookiesPath);
    console.log(`✅ Using cookies from: ${config.cookiesPath}`);
  } else {
    console.warn(`⚠️ Cookie file not found at: ${config.cookiesPath} (YouTube may hit bot checks)`);
  }
  // Lets yt-dlp solve YouTube JS challenges instead of degrading extraction.
  if (hasNodeRuntime()) args.push("--js-runtimes", "node");
  // Network resilience: don't hang forever on flaky mobile/CDN connections.
  args.push("--socket-timeout", "30", "--retries", "3", "--fragment-retries", "3");
  return args;
}

interface AttemptSpec {
  name: string;
  extraArgs: string[];
}

/**
 * Per-platform strategy chains. YouTube serves LOGIN_REQUIRED / bot-checks
 * inconsistently per player client, so retrying with mobile clients (which
 * get progressive mp4 streams) rescues some videos. TikTok aggressively
 * fingerprints TLS, so try browser impersonation first, then plain.
 */
function attemptsFor(platform: string): AttemptSpec[] {
  if (platform === "youtube") {
    return [
      { name: "default", extraArgs: ["-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba"] },
      {
        name: "android",
        extraArgs: ["--extractor-args", "youtube:player_client=android", "-f", "b[ext=mp4]/b"],
      },
      {
        name: "ios",
        extraArgs: ["--extractor-args", "youtube:player_client=ios", "-f", "b[ext=mp4]/b"],
      },
    ];
  }
  if (platform === "tiktok") {
    const attempts: AttemptSpec[] = [];
    if (supportsImpersonate()) {
      attempts.push({
        name: "impersonate",
        extraArgs: ["--impersonate", "chrome", "-f", "b[ext=mp4]/b"],
      });
    }
    attempts.push({ name: "default", extraArgs: ["-f", "b[ext=mp4]/b"] });
    return attempts;
  }
  if (platform === "instagram" || platform === "twitter") {
    return [{ name: "default", extraArgs: ["-f", "b[ext=mp4]/b"] }];
  }
  return [{ name: "default", extraArgs: ["-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"] }];
}

/** Errors where retrying another strategy (or fallback) is pointless. */
function isFatalError(msg: string): boolean {
  return (
    msg.includes("Unsupported URL") ||
    msg.includes("Video unavailable") ||
    msg.includes("Private video") ||
    msg.includes("This video is private") ||
    msg.includes("max-filesize") ||
    msg.includes("File is larger than") ||
    msg.includes("Requested format is not available")
  );
}

function isYouTubeBotCheck(msg: string): boolean {
  return /Sign in to confirm you.{0,10}re not a bot/i.test(msg) || /LOGIN_REQUIRED/.test(msg);
}

function isTikTokBlock(msg: string): boolean {
  return (
    msg.includes("Your IP address is blocked") ||
    msg.includes("Unexpected response from webpage") ||
    /TikTok.*(blocked|denied|capital|verify)/i.test(msg)
  );
}

/** Run one yt-dlp attempt. Resolves with stdout on success, rejects with combined output on failure. */
function runYtDlpAttempt(
  args: string[],
  onProgress?: (p: DownloadProgress) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ytDlpPath, args, { shell: false });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      const m = s.match(/(\d+\.\d+)%/);
      if (m && onProgress) onProgress({ percent: parseFloat(m[1]) });
    });

    proc.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      const m = s.match(/(\d+\.\d+)%/);
      if (m && onProgress) onProgress({ percent: parseFloat(m[1]) });
    });

    proc.on("error", (err) => reject(new Error(`Failed to spawn yt-dlp: ${err.message}`)));

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(stderr || stdout || `yt-dlp exited with code ${code}`));
      }
      resolve(stdout);
    });
  });
}

/** Turn `--print after_move:filepath` output (or a dir scan) into a validated video file. */
function resolveDownloadedFile(stdout: string, id: string, platform: string): DownloadResult {
  // Parse --print after_move:filepath output
  // When DASH merge fails (no ffmpeg), yt-dlp outputs MULTIPLE lines (video + audio)
  // We must pick the .mp4 line, NOT the .m4a line
  const lines = stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean);

  // Prefer .mp4 files from the output lines
  let filePath = lines.find((l) => l.endsWith(".mp4"));

  // If no .mp4 found, take the last line (usually the merged result)
  if (!filePath) {
    filePath = lines[lines.length - 1];
  }

  // Fallback: glob download dir for newest .mp4 file with id prefix
  if (!filePath || !fs.existsSync(filePath)) {
    const files = fs.readdirSync(config.downloadDir)
      .filter((f) => f.startsWith(id + "_") && f.endsWith(".mp4"))
      .map((f) => path.join(config.downloadDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (files.length > 0) filePath = files[0];
  }

  // Last fallback: any file with id prefix
  if (!filePath || !fs.existsSync(filePath)) {
    const files = fs.readdirSync(config.downloadDir)
      .filter((f) => f.startsWith(id + "_"))
      .map((f) => path.join(config.downloadDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (files.length > 0) filePath = files[0];
  }

  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("Download completed but file not found. Check yt-dlp output.");
  }

  const ext = path.extname(filePath).slice(1).toLowerCase() || "mp4";

  // GUARD: reject audio-only files
  if (AUDIO_EXTENSIONS.has(ext)) {
    try { fs.unlinkSync(filePath); } catch {}
    throw new Error(
      `❌ yt-dlp returned an audio file (.${ext}) instead of video. ` +
      `This URL may not have a downloadable video. Try a different link.`
    );
  }

  const stat = fs.statSync(filePath);
  return { filePath, fileName: path.basename(filePath), ext, size: stat.size, platform };
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "video";
}

/**
 * TikTok fallback: when yt-dlp is blocked (TikTok frequently blocks server IPs
 * or breaks the extractor with API changes), resolve the direct mp4 through
 * the tikwm API and download it with plain HTTPS.
 */
async function downloadTikTokFallback(
  url: string,
  id: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult> {
  console.log("🎵 yt-dlp failed for TikTok, trying fallback API…");
  const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
  let info: any = null;
  let apiError = "";
  // Two attempts: the API occasionally drops a request.
  for (let attempt = 1; attempt <= 2 && !info; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(apiUrl, {
        headers: { "User-Agent": TIKTOK_UA },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Fallback API HTTP ${res.status}`);
      info = await res.json();
    } catch (err: any) {
      apiError = err?.name === "AbortError" ? "timed out" : (err?.message || String(err));
      console.warn(`⚠️ TikTok fallback API attempt ${attempt} failed: ${apiError.slice(0, 120)}`);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
    } finally {
      clearTimeout(timeout);
    }
  }
  if (!info) {
    throw new Error("❌ TikTok fallback unreachable, please try again later.");
  }

  if (info?.code !== 0 || !info?.data) {
    const msg = String(info?.msg || "");
    console.warn(`TikTok fallback API error: code=${info?.code} msg=${msg}`);
    if (/pars/i.test(msg)) {
      throw new Error("❌ TikTok video not found. It may be private, deleted, or the link is wrong.");
    }
    throw new Error(`❌ TikTok download failed (${msg || "fallback error"}). Try another link.`);
  }

  // Prefer the no-watermark mp4, fall back to watermarked.
  const playUrl: string | undefined = info.data.play || info.data.wmplay;
  if (!playUrl) throw new Error("❌ TikTok fallback returned no video URL. Try another link.");

  const title: string | undefined = info.data.title;
  const fileName = `${id}_${sanitizeFileName(title || "tiktok")}.mp4`;
  const filePath = path.join(config.downloadDir, fileName);
  const maxBytes = config.maxFileSizeMB * 1024 * 1024;

  const dlController = new AbortController();
  const dlTimeout = setTimeout(() => dlController.abort(), 120000);
  try {
    const res = await fetch(playUrl, {
      headers: { "User-Agent": TIKTOK_UA, Referer: "https://www.tiktok.com/" },
      signal: dlController.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Video server HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length") || 0);
    if (total > maxBytes) {
      throw new Error(`❌ Video too large (>${config.maxFileSizeMB}MB). Try a shorter video.`);
    }
    const file = fs.createWriteStream(filePath);
    let received = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.length;
        if (received > maxBytes) {
          file.destroy();
          try { fs.unlinkSync(filePath); } catch {}
          throw new Error(`❌ Video too large (>${config.maxFileSizeMB}MB). Try a shorter video.`);
        }
        if (!file.write(chunk)) await new Promise<void>((r) => file.once("drain", r));
        if (total > 0 && onProgress) onProgress({ percent: (received / total) * 100 });
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        file.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    }
  } catch (err: any) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
    if (err?.name === "AbortError") throw new Error("❌ TikTok download timed out. Please try again.");
    throw err instanceof Error ? err : new Error(`❌ TikTok fallback download failed: ${err}`);
  } finally {
    clearTimeout(dlTimeout);
  }

  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    try { fs.unlinkSync(filePath); } catch {}
    throw new Error("❌ TikTok fallback returned an empty file. Try another link.");
  }
  console.log(`✅ TikTok fallback saved: ${fileName} (${(stat.size / 1048576).toFixed(1)} MB)`);
  return { filePath, fileName, title, ext: "mp4", size: stat.size, platform: "tiktok" };
}

/** Map raw yt-dlp output to short, actionable user-facing errors. */
function mapDownloadError(msg: string, platform: string): Error {
  if (msg.includes("Unsupported URL")) {
    return new Error("❌ Unsupported URL. Make sure the link is a public video.");
  }
  if (msg.includes("Video unavailable") || msg.includes("Private video") || msg.includes("This video is private")) {
    return new Error("❌ Video unavailable or private.");
  }
  if (msg.includes("max-filesize") || msg.includes("File is larger than")) {
    return new Error(`❌ Video too large (>${config.maxFileSizeMB}MB). Try a shorter video.`);
  }
  if (msg.includes("Requested format is not available")) {
    return new Error("❌ Requested format not available.");
  }
  if (platform === "youtube" && isYouTubeBotCheck(msg)) {
    console.error(
      "❌ YouTube bot-check hit. Fix: put logged-in YouTube cookies in " +
      `${config.cookiesPath} (Netscape format) or set COOKIES_FROM_BROWSER in .env, then restart.`
    );
    return new Error(
      "❌ YouTube blocked this download (bot verification).\n\n" +
      "🔧 Admin: export logged-in YouTube cookies to `cookies.txt` next to the bot " +
        "(or set `COOKIES_FROM_BROWSER=chrome` in .env) and restart the bot. See README 'Troubleshooting → YouTube'."
    );
  }
  if (platform === "tiktok" && isTikTokBlock(msg)) {
    return new Error(
      "❌ TikTok blocked this download (network restriction, or the video is private/deleted). " +
      "Please try again later or try another link."
    );
  }
  return new Error(`❌ Download failed:\n${msg.slice(0, 800)}`);
}

/**
 * Download video using yt-dlp.
 * Handles TikTok / YouTube / X-Twitter / Instagram.
 * Returns path to downloaded mp4 file.
 */
export async function downloadVideo(
  url: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult> {
  ensureDownloadDir();

  if (!checkYtDlp()) {
    throw new Error(
      `yt-dlp not found at "${config.ytDlpPath}". Install it: https://github.com/yt-dlp/yt-dlp#installation`
    );
  }

  const platform = detectPlatform(url);
  const id = crypto.randomBytes(6).toString("hex");
  const template = path.join(config.downloadDir, `${id}_%(title).100s.%(ext)s`);

  const baseArgs: string[] = [
    "--no-playlist",
    "--no-warnings",
    "--merge-output-format",
    "mp4",
    "--ffmpeg-location",
    config.ffmpegDir,
    "--max-filesize",
    `${config.maxFileSizeMB}M`,
    "-o",
    template,
    "--no-mtime",
    ...buildCommonArgs(),
  ];

  const attempts = attemptsFor(platform);
  let lastError = "";
  for (const attempt of attempts) {
    // Platform-specific format selectors
    // YouTube DASH: video-only + audio-only streams → merge into one mp4 (needs ffmpeg)
    // Mobile clients / TikTok/IG/Twitter: muxed mp4 files → single stream, no merge needed
    const args = [...baseArgs, ...attempt.extraArgs, "--print", "after_move:filepath", url];
    try {
      if (attempts.length > 1) console.log(`⏳ Trying ${platform} strategy: ${attempt.name}…`);
      const stdout = await runYtDlpAttempt(args, onProgress);
      return resolveDownloadedFile(stdout, id, platform);
    } catch (err: any) {
      lastError = err?.message || String(err);
      console.warn(`⚠️ ${platform} strategy "${attempt.name}" failed: ${lastError.slice(0, 200)}`);
      // Fatal errors (private/deleted/too large/unsupported) won't be fixed by another strategy.
      if (isFatalError(lastError)) throw mapDownloadError(lastError, platform);
    }
  }

  // All yt-dlp strategies exhausted → TikTok has a fallback API, others get a friendly error.
  if (platform === "tiktok" && config.tiktokFallback && !isFatalError(lastError)) {
    try {
      return await downloadTikTokFallback(url, id, onProgress);
    } catch (fallbackErr: any) {
      // Fallback gives its own user-friendly message; prefer it unless it is generic.
      const msg = fallbackErr?.message || "";
      if (msg.startsWith("❌")) throw fallbackErr;
    }
  }

  throw mapDownloadError(lastError || "yt-dlp failed without output", platform);
}

export function cleanupFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

export function cleanupOldFiles(maxAgeHours = 2): void {
  try {
    if (!fs.existsSync(config.downloadDir)) return;
    const now = Date.now();
    for (const f of fs.readdirSync(config.downloadDir)) {
      const fp = path.join(config.downloadDir, f);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > maxAgeHours * 3600 * 1000) fs.unlinkSync(fp);
      } catch {}
    }
  } catch {}
}
