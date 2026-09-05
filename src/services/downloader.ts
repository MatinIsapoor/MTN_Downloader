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
      console.warn(`⚠️ Cookies look INVALID: ${status.detail}. YouTube will fail until fresh cookies are uploaded (send cookies.txt to the bot, no restart needed).`);
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
    console.warn(
      `⚠️ No cookies configured (COOKIES_PATH=${config.cookiesPath} not found, COOKIES_FROM_BROWSER/COOKIES_CONTENT empty). ` +
        `YouTube downloads will likely fail with "Sign in to confirm you're not a bot". Send a cookies.txt to the bot or see README to set up cookies.`
    );
  }
  console.log(
    config.tiktokFallback
      ? "🔧 TikTok fallback providers: enabled (tikwm x2 + ssstik)"
      : "🔧 TikTok fallback providers: disabled (TIKTOK_FALLBACK=false)"
  );
}

const AUDIO_EXTENSIONS = new Set(["m4a", "mp3", "ogg", "opus", "wav", "aac", "flac", "wma"]);

const TIKTOK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Extra yt-dlp args derived from local capabilities: auth cookies + JS runtime. */
function buildCommonArgs(useCookies = true): string[] {
  const args: string[] = [];
  if (useCookies) {
    if (config.cookiesFromBrowser) {
      args.push("--cookies-from-browser", config.cookiesFromBrowser);
      console.log(`✅ Using cookies from browser: ${config.cookiesFromBrowser}`);
    } else if (fs.existsSync(config.cookiesPath)) {
      args.push("--cookies", config.cookiesPath);
      console.log(`✅ Using cookies from: ${config.cookiesPath}`);
    } else {
      console.warn(`⚠️ Cookie file not found at: ${config.cookiesPath} (YouTube may hit bot checks)`);
    }
  }
  // Lets yt-dlp solve YouTube JS challenges instead of degrading extraction.
  if (hasNodeRuntime()) args.push("--js-runtimes", "node");
  // Speed: parallel fragment downloads + skip TLS overhead.
  args.push(
    "--concurrent-fragments", "4",
    "--socket-timeout", "15",
    "--retries", "5",
    "--fragment-retries", "5",
    "--no-check-certificates"
  );
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
 * YouTube notes (yt-dlp 2025-2026):
 * - The default `web` client needs a PO-token/JS challenge AND a logged-in
 *   session from a datacenter IP (Render). `web_safari` / `web_embedded`
 *   are challenged far less often and DO honor cookies.txt.
 * - `tv` / `android` / `ios` do NOT honor Netscape cookies (different auth);
 *   worse, pairing cookies with `tv` can invalidate the exported session.
 *   So they run WITHOUT cookies as an anonymous last resort — many public
 *   videos still download that way even when the saved session is dead.
 */
function attemptsFor(platform: string): AttemptSpec[] {
  if (platform === "youtube") {
    return [
      // Cookie-respecting clients first (need a valid logged-in session).
      { name: "web", extraArgs: ["-f", "b[ext=mp4]/b"], useCookies: true },
      {
        name: "web_safari",
        extraArgs: ["--extractor-args", "youtube:player_client=web_safari", "-f", "b[ext=mp4]/b"],
        useCookies: true,
      },
      {
        name: "web_embedded",
        extraArgs: ["--extractor-args", "youtube:player_client=web_embedded", "-f", "b[ext=mp4]/b"],
        useCookies: true,
      },
      // Anonymous fallbacks WITHOUT cookies — rescue public videos even when
      // the saved session expired/was rejected.
      {
        name: "tv",
        extraArgs: ["--extractor-args", "youtube:player_client=tv", "-f", "b[ext=mp4]/b"],
        useCookies: false,
      },
      {
        name: "android",
        extraArgs: ["--extractor-args", "youtube:player_client=android", "-f", "b[ext=mp4]/b"],
        useCookies: false,
      },
    ];
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
      // Cookies ARE configured, and we already retried cookie-respecting
      // clients (web/web_safari/web_embedded) plus anonymous tv/android
      // fallbacks. If we are here, even the anonymous clients were blocked:
      // the video likely needs a valid login (age-gated/private) or the
      // datacenter IP is rate-limited. The saved session is expired/invalid.
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
      "❌ YouTube bot-check hit with NO cookies configured. Fix: put logged-in YouTube cookies in " +
      `${config.cookiesPath} (Netscape format) or set COOKIES_FROM_BROWSER in .env. No restart needed — the next download picks them up.`
    );
    return new Error(
      "❌ YouTube blocked this download (bot verification).\n\n" +
      "🔧 Admin: send a logged-in `cookies.txt` to the bot (or run /cookies for status). " +
        "No restart needed. See README 'Troubleshooting → YouTube'."
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
    "--downloader-args",
    "ffmpeg:-threads 0", // use all CPU cores for ffmpeg merge
    "--max-filesize",
    `${config.maxFileSizeMB}M`,
    "-o",
    template,
    "--no-mtime",
  ];

  const attempts = attemptsFor(platform);
  let lastError = "";
  for (const attempt of attempts) {
    // Cookies are attached per-attempt: cookie-respecting clients get them,
    // anonymous clients (tv/android) run WITHOUT them (they ignore cookies,
    // and pairing cookies+tv can even invalidate the saved session).
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
