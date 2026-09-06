import { spawn, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { config } from "../config";
import { detectPlatform } from "../utils/platform";
import { downloadYouTubeViaInvidious } from "./invidious";
import { downloadViaCobalt, isCobaltConfigured } from "./cobalt";

export interface DownloadResult {
  filePath: string;
  fileName: string;
  title?: string;
  ext: string;
  size: number;
  platform: string;
}

export interface AudioResult {
  filePath: string;
  fileName: string;
  size: number;
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
  if (config.cookiesContent) return true;
  try {
    return fs.existsSync(config.cookiesPath);
  } catch {
    return false;
  }
}

export interface CookieStatus {
  source: "browser" | "env" | "file" | "none";
  path: string;
  total: number;
  youtube: number;
  expiredYoutube: number;
  expiringSoon: number;
  hasLoginSession: boolean;
  valid: boolean;
  detail: string;
}

/** Parse a Netscape cookies file into rows. Returns null when unreadable. */
function parseCookieFile(raw: string): Array<{ domain: string; expires: number; name: string }> | null {
  try {
    const rows: Array<{ domain: string; expires: number; name: string }> = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const parts = t.split("\t");
      if (parts.length < 7) continue;
      const domain = parts[0] || "";
      const expires = Number(parts[4] || "0") || 0;
      const name = parts[5] || "";
      rows.push({ domain, expires, name });
    }
    return rows;
  } catch {
    return null;
  }
}

/** Decode COOKIES_CONTENT (raw Netscape text or base64) into file text. */
export function decodeCookiesEnv(raw: string): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  if (s.includes("youtube.com") && s.includes("\n")) return s;
  // Try base64 (Render dashboard-safe). Must decode to something cookie-like.
  try {
    const decoded = Buffer.from(s.replace(/\s+/g, ""), "base64").toString("utf8");
    if (decoded.includes("youtube.com") || decoded.includes("# Netscape")) return decoded;
  } catch {}
  // Single-line edge case: env var with literal \n escapes.
  if (s.includes("\\n")) {
    const unescaped = s.replace(/\\n/g, "\n");
    if (unescaped.includes("youtube.com")) return unescaped;
  }
  return null;
}

/** Validate raw cookies text. Shared by file, env var, and Telegram uploads. */
export function validateCookiesContent(raw: string): CookieStatus {
  const rows = parseCookieFile(raw);
  if (!rows) {
    return {
      source: "file", path: config.cookiesPath, total: 0, youtube: 0,
      expiredYoutube: 0, expiringSoon: 0, hasLoginSession: false, valid: false,
      detail: "unreadable",
    };
  }
  const now = Math.floor(Date.now() / 1000);
  const soon = now + 7 * 24 * 3600;
  const yt = rows.filter((r) => r.domain.includes("youtube.com"));
  const expired = yt.filter((r) => r.expires !== 0 && r.expires < now).length;
  const expiring = yt.filter((r) => r.expires !== 0 && r.expires >= now && r.expires < soon).length;
  const names = new Set(yt.map((r) => r.name));
  const hasLoginSession =
    (names.has("SID") || names.has("__Secure-1PSID") || names.has("__Secure-3PSID")) &&
    (names.has("LOGIN_INFO") || names.has("SSID") || names.has("HSID"));
  let detail: string;
  let valid = true;
  if (rows.length === 0) {
    detail = "file exists but has NO cookies (empty?) — re-export it";
    valid = false;
  } else if (yt.length === 0) {
    detail = `${rows.length} cookies but NONE for youtube.com — export while on youtube.com, logged in`;
    valid = false;
  } else if (!hasLoginSession) {
    detail = `${rows.length} cookies (${yt.length} for youtube.com) but NO login session (SID/LOGIN_INFO missing) — export while LOGGED IN at youtube.com`;
    valid = false;
  } else if (expired > 0 && expired >= yt.length / 2) {
    detail = `${yt.length} youtube cookies, but ${expired} are EXPIRED — re-export fresh cookies`;
    valid = false;
  } else {
    const kb = (Buffer.byteLength(raw, "utf8") / 1024).toFixed(1);
    detail = `${rows.length} cookies (${yt.length} for youtube.com, ${kb} KB)`;
    if (expired > 0) detail += `, ${expired} expired`;
    if (expiring > 0) detail += `, ${expiring} expire within 7 days`;
  }
  return {
    source: "file", path: config.cookiesPath, total: rows.length, youtube: yt.length,
    expiredYoutube: expired, expiringSoon: expiring,
    hasLoginSession, valid, detail,
  };
}

/** Save fresh cookies text to disk (used by env restore + Telegram upload). No restart needed. */
export function saveCookiesContent(raw: string): CookieStatus {
  const status = validateCookiesContent(raw);
  const dir = path.dirname(config.cookiesPath);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const normalized = raw.trim().endsWith("\n") ? raw.trim() + "\n" : raw.trim() + "\n";
    fs.writeFileSync(config.cookiesPath, normalized, "utf8");
  } catch (err: any) {
    throw new Error(`❌ Could not save cookies file (${config.cookiesPath}): ${err?.message || err}`);
  }
  if (!status.valid) {
    console.warn(`⚠️ Saved cookies look invalid: ${status.detail}`);
  } else {
    console.log(`✅ Cookies saved to ${config.cookiesPath} (${status.detail}) — applies to the next download, no restart needed.`);
  }
  return status;
}

/**
 * Render / Docker have ephemeral filesystems: a cookies.txt uploaded through
 * the dashboard shell vanishes on the next restart/redeploy. If COOKIES_CONTENT
 * is set, restore the file from it on every boot so sessions survive restarts.
 */
export function ensureCookiesFromEnv(): void {
  if (config.cookiesFromBrowser || !config.cookiesContent) return;
  const decoded = decodeCookiesEnv(config.cookiesContent);
  if (!decoded) {
    console.warn(
      "⚠️ COOKIES_CONTENT is set but could not be decoded (expected raw Netscape text or base64). Ignoring it."
    );
    return;
  }
  try {
    let current = "";
    try {
      current = fs.readFileSync(config.cookiesPath, "utf8");
    } catch {}
    if (current.trim() === decoded.trim()) {
      console.log("🔧 Cookies: COOKIES_CONTENT matches cookies file, nothing to restore.");
      return;
    }
    const status = saveCookiesContent(decoded);
    console.log(`🔧 Cookies: restored from COOKIES_CONTENT env var (${status.detail}).`);
  } catch (err: any) {
    console.warn(`⚠️ Failed to restore cookies from COOKIES_CONTENT: ${err?.message || err}`);
  }
}

/** Describe the cookie file so the admin can tell valid vs stale/missing at a glance. */
function describeCookieFile(): string {
  if (config.cookiesFromBrowser) return `reading from browser "${config.cookiesFromBrowser}"`;
  if (config.cookiesContent) {
    try {
      const raw = fs.readFileSync(config.cookiesPath, "utf8");
      return `${validateCookiesContent(raw).detail} [managed via COOKIES_CONTENT]`;
    } catch {
      return "COOKIES_CONTENT is set but cookies file is missing (will be restored on next boot)";
    }
  }
  try {
    const raw = fs.readFileSync(config.cookiesPath, "utf8");
    return validateCookiesContent(raw).detail;
  } catch {
    return "unreadable";
  }
}

/** Public status for the /cookies admin command. */
export function getCookiesStatus(): CookieStatus {
  if (config.cookiesFromBrowser) {
    return {
      source: "browser", path: config.cookiesFromBrowser, total: -1, youtube: -1,
      expiredYoutube: 0, expiringSoon: 0, hasLoginSession: true, valid: true,
      detail: `reading from browser "${config.cookiesFromBrowser}"`,
    };
  }
  try {
    const raw = fs.readFileSync(config.cookiesPath, "utf8");
    const s = validateCookiesContent(raw);
    s.source = config.cookiesContent ? "env" : "file";
    return s;
  } catch {
    return {
      source: "none", path: config.cookiesPath, total: 0, youtube: 0,
      expiredYoutube: 0, expiringSoon: 0, hasLoginSession: false, valid: false,
      detail: `no cookies file at ${config.cookiesPath}`,
    };
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
    const status = getCookiesStatus();
    console.log(`🔧 Cookies: using file ${config.cookiesPath} (${status.detail})`);
    if (!status.valid) {
      console.warn(`⚠️ Cookies look INVALID: ${status.detail}. Cookie-only videos will fail until fresh cookies are uploaded (send cookies.txt to the bot, no restart needed).`);
    } else if (status.expiringSoon > 0) {
      console.warn(`⚠️ ${status.expiringSoon} YouTube cookies expire within 7 days — plan a refresh soon (send a fresh cookies.txt to the bot).`);
    }
    if (!config.cookiesContent && process.env.RENDER_EXTERNAL_URL) {
      console.warn(
        "⚠️ Running on Render without COOKIES_CONTENT: cookies.txt will be LOST on the next restart/redeploy. " +
          "Paste the file into the COOKIES_CONTENT env var to make it persistent."
      );
    }
  } else {
    console.log(
      `🔧 Cookies: none configured — YouTube runs cookie-free (anonymous clients first). ` +
        `Most public videos work; age-gated/private ones need cookies (send cookies.txt to the bot).`
    );
  }
  console.log(`🔧 YouTube mode: cookie=${config.youtubeCookieMode}, max-height=${config.youtubeMaxHeight === 0 ? "uncapped" : config.youtubeMaxHeight + "p"}`);
  console.log(
    config.invidiousEnabled
      ? `⚡ Fast path: Invidious ENABLED for YouTube (${config.invidiousInstances.length} instances, tried before yt-dlp)`
      : "⚡ Fast path: Invidious disabled (INVIDIOUS_ENABLED=false) — YouTube goes straight to yt-dlp"
  );
  console.log(
    isCobaltConfigured()
      ? `⚡ Fast path: Cobalt API configured (${config.cobaltApiUrl}, tried first for all platforms)`
      : "⚡ Fast path: Cobalt API not configured (set COBALT_API_URL to your self-hosted instance to enable)"
  );
  console.log(
    hasAria2c()
      ? "🔧 Downloader: aria2c available (8-connection fast downloads enabled)"
      : "🔧 Downloader: native (install aria2c for faster progressive-mp4 downloads)"
  );
  if (config.ytDlpProxy) console.log("🔧 Proxy: YT_DLP_PROXY is set (YouTube traffic routed via proxy)");
  else if (process.env.RENDER_EXTERNAL_URL || process.env.RENDER)
    console.log("🔧 Proxy: none (datacenter IP — if YouTube hard-blocks it, set YT_DLP_PROXY to a residential proxy)");
  console.log(
    config.tiktokFallback
      ? "🔧 TikTok fallback providers: enabled (tikwm x2 + ssstik)"
      : "🔧 TikTok fallback providers: disabled (TIKTOK_FALLBACK=false)"
  );
}

const AUDIO_EXTENSIONS = new Set(["m4a", "mp3", "ogg", "opus", "wav", "aac", "flac", "wma"]);

const TIKTOK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

let _hasAria2c: boolean | null = null;
/** aria2c with 8 connections downloads progressive mp4s much faster than native. */
function hasAria2c(): boolean {
  if (_hasAria2c === null) {
    try {
      execSync("aria2c --version", { stdio: "ignore" });
      _hasAria2c = true;
    } catch {
      _hasAria2c = false;
    }
  }
  return _hasAria2c;
}

/** Resolution-capped muxed-mp4 selector: 720p default = 3-5x smaller = much faster. */
function youtubeFormat(): string {
  const h = config.youtubeMaxHeight;
  if (h > 0) return `b[height<=${h}][ext=mp4]/b[ext=mp4]/b`;
  return "b[ext=mp4]/b";
}

/** Extra yt-dlp args derived from local capabilities: auth cookies + JS runtime. */
function buildCommonArgs(useCookies = true): string[] {
  const args: string[] = [];
  const cookieMode = config.youtubeCookieMode;
  const wantCookies = useCookies && cookieMode !== "never";
  if (wantCookies) {
    if (config.cookiesFromBrowser) {
      args.push("--cookies-from-browser", config.cookiesFromBrowser);
      console.log(`✅ Using cookies from browser: ${config.cookiesFromBrowser}`);
    } else if (fs.existsSync(config.cookiesPath)) {
      args.push("--cookies", config.cookiesPath);
      console.log(`✅ Using cookies from: ${config.cookiesPath}`);
    } else {
      console.warn(`⚠️ Cookie file not found at: ${config.cookiesPath} (trying without cookies)`);
    }
  }
  // Optional residential proxy — the only fix when the datacenter IP itself is flagged.
  if (config.ytDlpProxy) args.push("--proxy", config.ytDlpProxy);
  // Lets yt-dlp solve YouTube JS challenges instead of degrading extraction.
  if (hasNodeRuntime()) args.push("--js-runtimes", "node");
  // Speed: chunked HTTP bypasses per-connection throttling on progressive mp4s;
  // parallel fragments help DASH/HLS; short timeouts + few retries fail over
  // to the next player client fast instead of stalling on a blocked one.
  args.push(
    "--concurrent-fragments", "8",
    "--http-chunk-size", "10M",
    "--buffer-size", "16K",
    "--socket-timeout", "10",
    "--retries", "3",
    "--fragment-retries", "3",
    "--no-check-certificates"
  );
  // aria2c (8 connections) is far faster than the native downloader for
  // progressive http mp4s, when it is installed. Probe once, use if present.
  if (hasAria2c()) {
    args.push(
      "--downloader", "aria2c",
      "--downloader-args", "aria2c:-x 8 -s 8 -k 1M --min-split-size=1M"
    );
  }
  return args;
}

interface AttemptSpec {
  name: string;
  extraArgs: string[];
  /** false = run WITHOUT any cookies (anonymous clients that ignore/reject them). */
  useCookies: boolean;
}

/**
 * Per-platform strategy chains.
 *
 * YouTube notes (verified by probing yt-dlp 2026.08.19 with bot-exact args,
 * no cookies, public video — exit 0 = works, FAIL = broken):
 * - android OK (returns progressive mp4, no merge needed — fastest path).
 * - mweb / web_safari / web_embedded OK (need `--js-runtimes node`, which the
 *   bot always passes; without a JS runtime their https formats vanish and
 *   every `-f` selector fails with "Requested format is not available").
 * - default (yt-dlp's own visionos→… chain) OK — kept last as a catch-all
 *   since it internally retries several clients (slower).
 * - tv FAIL ("The page needs to be reloaded") — YouTube moved TVHTML5 to a
 *   new JS challenge yt-dlp can't solve yet. Removed: it only wasted 10-20s
 *   and burned IP reputation on a guaranteed failure. Do NOT re-add it with
 *   cookies either — cookies+tv can invalidate the exported session.
 * - ios FAIL for our mp4 selector (HLS-only streams) — removed.
 * - Order: anonymous first so public videos need no cookies; cookie clients
 *   only as fallback for age-gated/private/rate-limited videos. Cookie
 *   attempts are skipped entirely when no cookies are configured.
 */
function attemptsFor(platform: string): AttemptSpec[] {
  if (platform === "youtube") {
    const fmt = youtubeFormat();
    const anonymous: AttemptSpec[] = [
      {
        name: "android",
        extraArgs: ["--extractor-args", "youtube:player_client=android", "-f", fmt],
        useCookies: false,
      },
      {
        name: "mweb",
        extraArgs: ["--extractor-args", "youtube:player_client=mweb", "-f", fmt],
        useCookies: false,
      },
      {
        name: "web_safari",
        extraArgs: ["--extractor-args", "youtube:player_client=web_safari", "-f", fmt],
        useCookies: false,
      },
      {
        name: "web_embedded",
        extraArgs: ["--extractor-args", "youtube:player_client=web_embedded", "-f", fmt],
        useCookies: false,
      },
      { name: "default", extraArgs: ["-f", fmt], useCookies: false },
    ];
    const withCookies: AttemptSpec[] = [
      {
        name: "web_safari",
        extraArgs: ["--extractor-args", "youtube:player_client=web_safari", "-f", fmt],
        useCookies: true,
      },
      { name: "web", extraArgs: ["-f", fmt], useCookies: true },
    ];
    if (config.youtubeCookieMode === "never") return anonymous;
    if (config.youtubeCookieMode === "cookies") return [...withCookies, ...anonymous];
    // "auto" (default): anonymous first; downloadVideo() drops the cookie
    // attempts when no cookies are configured, saving wasted retries.
    return [...anonymous, ...withCookies];
  }
  if (platform === "tiktok") {
    const attempts: AttemptSpec[] = [];
    if (supportsImpersonate()) {
      attempts.push({
        name: "impersonate",
        extraArgs: ["--impersonate", "chrome", "-f", "b[ext=mp4]/b"],
        useCookies: true,
      });
    }
    attempts.push({ name: "default", extraArgs: ["-f", "b[ext=mp4]/b"], useCookies: true });
    return attempts;
  }
  if (platform === "instagram" || platform === "twitter") {
    return [{ name: "default", extraArgs: ["-f", "b[ext=mp4]/b"], useCookies: true }];
  }
  return [{ name: "default", extraArgs: ["-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"], useCookies: true }];
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
  return (
    /Sign in to confirm you.{0,10}re not a bot/i.test(msg) ||
    /not a bot/i.test(msg) ||
    /LOGIN_REQUIRED/.test(msg) ||
    /The page needs to be reloaded/i.test(msg) ||
    /confirm your age/i.test(msg) ||
    /use --cookies/i.test(msg)
  );
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

/** Thrown when a provider confirms the video itself is gone — no point trying other providers. */
class VideoNotFoundError extends Error {}

interface TikTokResolved {
  playUrl: string;
  title?: string;
  source: string;
}

const VIDEO_NOT_FOUND_MSG =
  "❌ TikTok video not found. It may be private, deleted, or the link is wrong.";

/** GET JSON with timeout + one retry for transient network blips. */
async function fetchJson(url: string, headers: Record<string, string>, timeoutMs = 30000): Promise<any> {
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err: any) {
      lastError = err?.name === "AbortError" ? "timed out" : (err?.message || String(err));
      console.warn(`⚠️ GET ${url.slice(0, 60)}… attempt ${attempt} failed: ${lastError.slice(0, 120)}`);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(lastError || "request failed");
}

/** tikwm JSON API resolver (used with two independent hosts). */
async function resolveViaTikwm(apiBase: string, videoUrl: string): Promise<TikTokResolved> {
  const info = await fetchJson(
    `${apiBase}/api/?url=${encodeURIComponent(videoUrl)}`,
    { "User-Agent": TIKTOK_UA }
  );
  if (info?.code !== 0 || !info?.data) {
    console.warn(`tikwm (${apiBase}) error: code=${info?.code} msg=${info?.msg}`);
    // tikwm answers code != 0 for bad/deleted/private videos — other providers
    // will fail the same way, so short-circuit with a clear message.
    throw new VideoNotFoundError(VIDEO_NOT_FOUND_MSG);
  }
  // Prefer the no-watermark mp4, fall back to watermarked.
  const playUrl: string | undefined = info.data.play || info.data.wmplay;
  if (!playUrl) throw new VideoNotFoundError(VIDEO_NOT_FOUND_MSG);
  return { playUrl, title: info.data.title, source: `tikwm@${apiBase}` };
}

/**
 * ssstik.io resolver (fully independent provider).
 * GET /en (grab s_tt token + cookies) → POST /abc?url=dl → parse download link.
 */
async function resolveViaSsstik(videoUrl: string): Promise<TikTokResolved> {
  const pageRes = await fetch("https://ssstik.io/en", { headers: { "User-Agent": TIKTOK_UA } });
  if (!pageRes.ok) throw new Error(`ssstik page HTTP ${pageRes.status}`);
  const html = await pageRes.text();
  const token = html.match(/s_tt\s*=\s*'([^']+)'/)?.[1];
  if (!token) throw new Error("ssstik token not found (page layout changed?)");
  const cookies = [...pageRes.headers.getSetCookie()].map((c) => c.split(";")[0]).join("; ");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let resultHtml = "";
  try {
    const res = await fetch("https://ssstik.io/abc?url=dl", {
      method: "POST",
      headers: {
        "User-Agent": TIKTOK_UA,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Origin: "https://ssstik.io",
        Referer: "https://ssstik.io/en",
        Cookie: cookies,
      },
      body: new URLSearchParams({ id: videoUrl, locale: "en", tt: token }).toString(),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`ssstik resolve HTTP ${res.status}`);
    resultHtml = await res.text();
  } finally {
    clearTimeout(timeout);
  }
  // First https link is the no-watermark download.
  const playUrl = [...resultHtml.matchAll(/href="(https:[^"]+)"/g)].map((m) => m[1])[0];
  if (!playUrl) {
    console.warn(`ssstik returned no download link (len=${resultHtml.length})`);
    throw new VideoNotFoundError(VIDEO_NOT_FOUND_MSG);
  }
  return { playUrl, source: "ssstik" };
}

/** Stream a remote mp4 to disk with max-size enforcement. */
async function downloadFileTo(
  fileUrl: string,
  filePath: string,
  referer: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<void> {
  const maxBytes = config.maxFileSizeMB * 1024 * 1024;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    const res = await fetch(fileUrl, {
      headers: { "User-Agent": TIKTOK_UA, Referer: referer },
      signal: controller.signal,
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
    throw err instanceof Error ? err : new Error(`❌ TikTok download failed: ${err}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * TikTok fallback: when yt-dlp is blocked (TikTok frequently blocks server IPs
 * or breaks the extractor with API changes), resolve the direct mp4 through
 * independent third-party providers and download it with plain HTTPS.
 */
async function downloadTikTokFallback(
  url: string,
  id: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult> {
  console.log("🎵 yt-dlp failed for TikTok, trying fallback providers…");
  const providers: Array<{ name: string; run: () => Promise<TikTokResolved> }> = [
    { name: "tikwm.com", run: () => resolveViaTikwm("https://www.tikwm.com", url) },
    { name: "tikwm-apex", run: () => resolveViaTikwm("https://tikwm.com", url) },
    { name: "ssstik", run: () => resolveViaSsstik(url) },
  ];

  let resolved: TikTokResolved | null = null;
  const failures: string[] = [];
  for (const p of providers) {
    try {
      console.log(`🎵 TikTok fallback provider: ${p.name}…`);
      resolved = await p.run();
      console.log(`✅ TikTok resolved via ${resolved.source}`);
      break;
    } catch (err: any) {
      // Video is gone, or a decisive error (e.g. too large) — don't hammer other providers.
      if (err instanceof VideoNotFoundError || err?.message?.startsWith("❌")) throw err;
      const msg = err?.message || String(err);
      console.warn(`⚠️ TikTok provider ${p.name} failed: ${msg.slice(0, 150)}`);
      failures.push(`${p.name}: ${msg.slice(0, 100)}`);
    }
  }

  if (!resolved) {
    console.error(`❌ All TikTok fallback providers failed: ${failures.join(" | ")}`);
    throw new Error(
      "❌ TikTok is unreachable right now (its anti-bot blocks this server's network on every route). " +
      "Please try again in a few minutes or try another link."
    );
  }

  const fileName = `${id}_${sanitizeFileName(resolved.title || "tiktok")}.mp4`;
  const filePath = path.join(config.downloadDir, fileName);
  await downloadFileTo(resolved.playUrl, filePath, "https://www.tiktok.com/", onProgress);

  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    try { fs.unlinkSync(filePath); } catch {}
    throw new Error("❌ TikTok fallback returned an empty file. Try another link.");
  }
  console.log(`✅ TikTok fallback saved: ${fileName} (${(stat.size / 1048576).toFixed(1)} MB)`);
  return { filePath, fileName, title: resolved.title, ext: "mp4", size: stat.size, platform: "tiktok" };
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
    if (hasCookies()) {
      // Anonymous clients (android/mweb/web_safari/web_embedded/default) + cookie clients
      // (web_safari/web) all failed. The video likely needs a valid login
      // (age-gated/private/members-only) or the datacenter IP is
      // rate-limited. The saved session may be expired/invalid.
      const status = getCookiesStatus();
      console.error(
        `❌ YouTube bot-check hit DESPITE cookies (${describeCookieFile()}). ` +
        `The cookies are expired/invalid — refresh them (no restart needed).`
      );
      const hint = status.valid
        ? "The file looks OK, so YouTube is likely rate-limiting this server's IP — wait ~1 hour and try again, then refresh cookies if it persists."
        : `Cookie problem: ${status.detail}.`;
      return new Error(
        "❌ YouTube still blocked this download — the saved cookies were rejected (expired or logged-out).\n\n" +
        `${hint}\n\n` +
        "🔧 Admin: send a fresh `cookies.txt` to the bot (it updates instantly, no restart), " +
        "or run /cookies for status. Export tip: log in at youtube.com in a FRESH private window, " +
        "export immediately, then close the window without logging out. " +
        "On Render also paste the file into the COOKIES_CONTENT env var so it survives restarts. " +
        "Use a throwaway Google account — downloader sessions get flagged."
      );
    }
    console.error(
      "❌ YouTube bot-check hit with NO cookies configured (anonymous clients android/mweb/web_safari/web_embedded/default all blocked). " +
        "This video needs a login (age-gated/private) or the server IP is rate-limited, or yt-dlp is stale."
    );
    return new Error(
      "❌ YouTube blocked this download (bot verification, no cookies on file).\n\n" +
      "Most public videos work without cookies — this one doesn't (age-gated, private, " +
      "or the server IP is temporarily rate-limited: wait ~1 hour and retry).\n\n" +
      "🔧 Admin: for login-gated videos, send a logged-in `cookies.txt` to the bot " +
      "(or run /cookies for status). No restart needed.\n" +
      "If EVERY video fails: redeploy on Render (the build installs a fresh yt-dlp nightly — " +
      "a build more than ~2 weeks old fails on its own as YouTube changes its player), then if it " +
      "persists, the datacenter IP is flagged — set YT_DLP_PROXY to a residential proxy."
    );
  }
  if (platform === "tiktok" && isTikTokBlock(msg)) {
    return new Error(
      "❌ TikTok blocked this download (network restriction, or the video is private/deleted). " +
      "Please try again later or try another link."
    );
  }
  if (platform === "youtube" && msg.includes("Failed to extract any player response")) {
    // yt-dlp got zero usable player data from ANY client. On a datacenter IP
    // this is the harsh form of the login-wall/rate-limit (elsewhere it
    // surfaces as "Sign in to confirm you're not a bot"); on an old build it
    // just means yt-dlp predates YouTube's current player.
    console.error(
      `❌ YouTube returned no player response for this video (all clients failed).`
    );
    return new Error(
      "❌ YouTube returned no playable data for this video.\n\n" +
      "Most likely, in order: (1) this video is login-walled by YouTube " +
      "(age-restricted/private — these fail on every client even outside Render, " +
      "so a logged-in `cookies.txt` is the only fix), " +
      "(2) your Render build is stale — redeploy so the build installs a fresh " +
      "yt-dlp nightly (builds older than ~2 weeks die on their own as YouTube " +
      "changes its player), " +
      "(3) the server IP is hard-blocked — wait ~1 hour or set YT_DLP_PROXY.\n\n" +
      "🔧 Admin: run /cookies for status; to test the video, open it logged-OUT " +
      "in an incognito window — if YouTube asks you to sign in, cookies are mandatory."
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

  const platform = detectPlatform(url);

  // --- Fast path 1: Cobalt API (all platforms, only when self-hosted instance configured).
  // Single direct MP4, no yt-dlp, no ffmpeg merge — fastest when available.
  if (isCobaltConfigured()) {
    try {
      console.log(`⚡ Trying fast path: Cobalt (${platform})…`);
      const fast = await downloadViaCobalt(url, platform, onProgress);
      if (fast) return fast;
    } catch (err: any) {
      if (err?.message?.startsWith("❌")) throw err; // definitive (gone/too large)
      console.warn(`⚠️ Cobalt fast path failed, continuing: ${(err?.message || String(err)).slice(0, 150)}`);
    }
  }

  // --- Fast path 2: Invidious (YouTube only, no setup needed).
  // Bypasses yt-dlp's bot-checks (instance IP, not ours) and the slow DASH
  // merge by downloading a single progressive MP4 with plain HTTPS.
  if (platform === "youtube" && config.invidiousEnabled) {
    try {
      console.log("⚡ Trying fast path: Invidious (YouTube)…");
      const fast = await downloadYouTubeViaInvidious(url, onProgress);
      if (fast) return fast;
      console.log("⚡ Invidious unavailable for this video, falling back to yt-dlp…");
    } catch (err: any) {
      if (err?.message?.startsWith("❌")) throw err; // definitive (too large)
      console.warn(`⚠️ Invidious fast path failed, falling back to yt-dlp: ${(err?.message || String(err)).slice(0, 150)}`);
    }
  }

  if (!checkYtDlp()) {
    throw new Error(
      `yt-dlp not found at "${config.ytDlpPath}". Install it: https://github.com/yt-dlp/yt-dlp#installation`
    );
  }

  const id = crypto.randomBytes(6).toString("hex");
  const template = path.join(config.downloadDir, `${id}_%(title).100s.%(ext)s`);

  const baseArgs: string[] = [
    "--no-playlist",
    "--no-warnings",
    "--merge-output-format",
    "mp4",
    "--ffmpeg-location",
    config.ffmpegDir,
    "--downloader-args",
    "ffmpeg:-threads 0", // use all CPU cores for ffmpeg merge
    "--max-filesize",
    `${config.maxFileSizeMB}M`,
    "-o",
    template,
    "--no-mtime",
  ];

  const attempts = attemptsFor(platform).filter((a) => {
    // Skip cookie attempts when there is nothing to send — each one would
    // just waste 10-30s failing the same way as the anonymous attempts.
    if (platform === "youtube" && a.useCookies && !hasCookies()) {
      console.log(`⏭️ Skipping ${platform} strategy "${a.name}" (no cookies configured)`);
      return false;
    }
    return true;
  });
  let lastError = "";
  const allErrors: string[] = [];
  for (const attempt of attempts) {
    // Cookies are attached per-attempt: cookie-respecting clients get them,
    // anonymous clients run WITHOUT them (some ignore cookies, and pairing
    // cookies+tv can even invalidate the saved session).
    const args = [
      ...baseArgs,
      ...buildCommonArgs(attempt.useCookies),
      ...attempt.extraArgs,
      "--print",
      "after_move:filepath",
      url,
    ];
    try {
      if (attempts.length > 1)
        console.log(
          `⏳ Trying ${platform} strategy: ${attempt.name}${attempt.useCookies ? " (cookies)" : " (no cookies)"}…`
        );
      const stdout = await runYtDlpAttempt(args, onProgress);
      return resolveDownloadedFile(stdout, id, platform);
    } catch (err: any) {
      lastError = err?.message || String(err);
      allErrors.push(`[${attempt.name}] ${lastError}`);
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

  // Diagnose from the combined output of ALL attempts, not just the last one:
  // clients fail differently (bot-check on one, empty player response on
  // another) for the same root cause, and the last error alone misleads.
  const combinedError = allErrors.join("\n") || lastError || "yt-dlp failed without output";
  throw mapDownloadError(combinedError, platform);
}

export function cleanupFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

/** Resolve the ffmpeg binary: explicit FFMPEG_PATH file > local dir binary > PATH. */
function getFfmpegBinary(): string {
  const envPath = (process.env.FFMPEG_PATH || "").trim();
  if (envPath) {
    try {
      const resolved = path.resolve(envPath);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    } catch {}
    // If FFMPEG_PATH points to something on PATH or is a dir, fall through.
    if (!envPath.includes("/") && !envPath.includes("\\")) return envPath;
  }
  const localWin = path.join(config.ffmpegDir, "ffmpeg.exe");
  const localNix = path.join(config.ffmpegDir, "ffmpeg");
  try {
    if (fs.existsSync(localWin)) return localWin;
  } catch {}
  try {
    if (fs.existsSync(localNix)) return localNix;
  } catch {}
  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

/**
 * Extract the video's audio track to MP3 using ffmpeg.
 * Returns the mp3 path. Throws if the video has no audio track or ffmpeg fails.
 */
export function extractAudio(videoPath: string): Promise<AudioResult> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(videoPath)) {
      return reject(new Error("Video file not found for audio extraction."));
    }
    const parsed = path.parse(videoPath);
    const audioFileName = `${parsed.name}.mp3`;
    const audioPath = path.join(parsed.dir, audioFileName);
    try {
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    } catch {}

    const ffmpeg = getFfmpegBinary();
    const args = ["-y", "-i", videoPath, "-vn", "-c:a", "libmp3lame", "-q:a", "4", audioPath];
    const proc = spawn(ffmpeg, args, { shell: false });
    let stderr = "";

    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.stdout.on("data", () => {});

    proc.on("error", (err) => {
      reject(new Error(`Failed to run ffmpeg (${ffmpeg}): ${err.message}. Install ffmpeg: https://ffmpeg.org/download.html`));
    });

    proc.on("close", (code) => {
      try {
        if (code === 0 && fs.existsSync(audioPath)) {
          const stat = fs.statSync(audioPath);
          if (stat.size === 0) {
            try { fs.unlinkSync(audioPath); } catch {}
            return reject(new Error("⚠️ This video has no audio track, so no music file was created."));
          }
          console.log(`🎵 Audio extracted: ${audioFileName} (${(stat.size / 1048576).toFixed(2)} MB)`);
          return resolve({ filePath: audioPath, fileName: audioFileName, size: stat.size });
        }
        try {
          if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        } catch {}
        if (/does not contain any stream|Output file is empty|no audio/i.test(stderr)) {
          return reject(new Error("⚠️ This video has no audio track, so no music file was created."));
        }
        reject(new Error(`Audio extraction failed (ffmpeg exit ${code}). ${stderr.slice(-300).trim()}`));
      } catch (err: any) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
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
