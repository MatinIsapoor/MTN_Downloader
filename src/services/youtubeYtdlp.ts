import { spawn, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { config } from "../config";
import type { DownloadProgress, DownloadResult } from "./downloader";

/**
 * YouTube via local yt-dlp — the FINAL fallback method in the pipeline.
 *
 * Why this is "another method" and not more of the same:
 * - Cobalt / Piped / Invidious resolve on THIRD-PARTY server IPs.
 * - youtubei multi-client posts from OUR IP but only reads direct `url`
 *   fields (no signature deciphering, no JS challenges, no cookies).
 * - yt-dlp is a different engine: it solves YouTube's JS challenges
 *   (with node), deciphers signatureCipher'd streams, rotates its own
 *   player clients (android/ios/mweb/tv/web), can attach login cookies,
 *   can impersonate Chrome TLS, and can route via a residential proxy.
 *   Videos that are unwinnable for plain-HTTPS pipelines regularly still
 *   download here — and vice versa. That independence is the point.
 *
 * Order inside this method: anonymous player clients first
 * (android → ios → mweb → tv → default), then cookie-attached attempts
 * (when cookies exist and YOUTUBE_COOKIE_MODE allows them), so most
 * public videos download without ever touching the login session.
 * Disable with YOUTUBE_YTDLP_FALLBACK=false.
 *
 * Returns the downloaded file on success, null when every attempt fails
 * (caller builds the final user-facing error), and throws user-facing
 * errors (❌…) for definitive failures (private/deleted/too large).
 */

const AUDIO_EXTENSIONS = new Set(["m4a", "mp3", "ogg", "opus", "wav", "aac", "flac", "wma"]);

let _hasNode: boolean | null = null;
function hasNodeRuntime(): boolean {
  if (_hasNode === null) {
    try {
      execSync("node --version", { stdio: "ignore" });
      _hasNode = true;
    } catch {
      _hasNode = false;
    }
  }
  return _hasNode;
}

let _impersonate: boolean | null = null;
function supportsImpersonate(): boolean {
  if (_impersonate === null) {
    try {
      execSync(`"${config.ytDlpPath}" --impersonate chrome --version`, { stdio: "ignore" });
      _impersonate = true;
    } catch {
      _impersonate = false;
    }
  }
  return _impersonate;
}

let _aria2c: boolean | null = null;
function hasAria2c(): boolean {
  if (_aria2c === null) {
    try {
      execSync("aria2c --version", { stdio: "ignore" });
      _aria2c = true;
    } catch {
      _aria2c = false;
    }
  }
  return _aria2c;
}

let _ytDlp: boolean | null = null;
function ytDlpAvailable(): boolean {
  if (_ytDlp === null) {
    try {
      execSync(`"${config.ytDlpPath}" --version`, { stdio: "ignore" });
      _ytDlp = true;
    } catch {
      _ytDlp = false;
    }
  }
  return _ytDlp;
}

/** Any cookie source configured (browser / env / usable file)? */
function hasUsableCookies(): boolean {
  if (config.cookiesFromBrowser) return true;
  if (config.cookiesContent) return true;
  try {
    const st = fs.statSync(config.cookiesPath);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/** Format selector: mobile clients get itag-18 progressive (no merge); default is height-capped. */
function formatFor(playerClient: string | null): string {
  if (playerClient === "android" || playerClient === "ios" || playerClient === "mweb") {
    return "18/b[ext=mp4]/b";
  }
  const h = config.youtubeMaxHeight;
  if (h > 0) {
    return `bv*[ext=mp4][height<=${h}]+ba[ext=m4a]/b[ext=mp4][height<=${h}]/b[height<=${h}]/b`;
  }
  return "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b";
}

interface AttemptSpec {
  name: string;
  playerClient: string | null;
  useCookies: boolean;
}

/** Per-client rotation. Anonymous first (auto), cookies first (cookies), anon only (never). */
function attemptsForYouTube(): AttemptSpec[] {
  const anon: AttemptSpec[] = [
    { name: "android", playerClient: "android", useCookies: false },
    { name: "ios", playerClient: "ios", useCookies: false },
    { name: "mweb", playerClient: "mweb", useCookies: false },
    { name: "tv", playerClient: "tv", useCookies: false },
    { name: "default", playerClient: null, useCookies: false },
  ];
  const mode = config.youtubeCookieMode;
  if (mode === "never" || !hasUsableCookies()) return anon;
  const withCookies: AttemptSpec[] = [
    { name: "android+cookies", playerClient: "android", useCookies: true },
    { name: "default+cookies", playerClient: null, useCookies: true },
  ];
  return mode === "cookies" ? [...withCookies, ...anon] : [...anon, ...withCookies];
}

/** Extra yt-dlp args for one YouTube attempt. */
function buildYoutubeArgs(playerClient: string | null, format: string, useCookies: boolean): string[] {
  const args: string[] = [];
  if (useCookies) {
    if (config.cookiesFromBrowser) {
      args.push("--cookies-from-browser", config.cookiesFromBrowser);
    } else {
      try {
        if (fs.existsSync(config.cookiesPath)) args.push("--cookies", config.cookiesPath);
      } catch {}
    }
  }
  // Combine youtube extractor keys into ONE --extractor-args (semicolon-separated).
  const ytKeys: string[] = [];
  if (playerClient) ytKeys.push(`player_client=${playerClient}`);
  if (config.youtubePlayerSkip) ytKeys.push("player_skip=webpage,configs");
  if (ytKeys.length > 0) args.push("--extractor-args", `youtube:${ytKeys.join(";")}`);
  if (config.ytDlpProxy) args.push("--proxy", config.ytDlpProxy);
  if (config.ytDlpForceIpv4) args.push("--force-ipv4");
  if (config.potServerUrl) {
    args.push("--extractor-args", `youtubepot-bgutilhttp:base_url=${config.potServerUrl}`);
  }
  if (hasNodeRuntime()) args.push("--js-runtimes", "node");
  if (supportsImpersonate()) args.push("--impersonate", "chrome");
  args.push(
    "--concurrent-fragments", "8",
    "--http-chunk-size", "10M",
    "--buffer-size", "16K",
    "--socket-timeout", "10",
    "--retries", "3",
    "--fragment-retries", "3",
    "--no-check-certificates"
  );
  if (hasAria2c()) {
    args.push(
      "--downloader", "aria2c",
      "--downloader-args", "aria2c:-x 8 -s 8 -k 1M --min-split-size=1M"
    );
  }
  if (config.ytDlpExtraArgs.length > 0) args.push(...config.ytDlpExtraArgs);
  args.push("-f", format);
  return args;
}

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

function isBotCheck(msg: string): boolean {
  return (
    /Sign in to confirm you.{0,10}re not a bot/i.test(msg) ||
    /not a bot/i.test(msg) ||
    /LOGIN_REQUIRED/.test(msg) ||
    /The page needs to be reloaded/i.test(msg) ||
    /confirm your age/i.test(msg) ||
    /use --cookies/i.test(msg) ||
    /Failed to extract any player response/i.test(msg)
  );
}

function runYtDlpAttempt(args: string[], onProgress?: (p: DownloadProgress) => void): Promise<string> {
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
      if (code !== 0) return reject(new Error(stderr || stdout || `yt-dlp exited with code ${code}`));
      resolve(stdout);
    });
  });
}

function resolveDownloadedFile(stdout: string, id: string): DownloadResult {
  const lines = stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  let filePath = lines.find((l) => l.endsWith(".mp4"));
  if (!filePath) filePath = lines[lines.length - 1];
  if (!filePath || !fs.existsSync(filePath)) {
    const files = fs.readdirSync(config.downloadDir)
      .filter((f) => f.startsWith(id + "_") && f.endsWith(".mp4"))
      .map((f) => path.join(config.downloadDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (files.length > 0) filePath = files[0];
  }
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
  if (AUDIO_EXTENSIONS.has(ext)) {
    try { fs.unlinkSync(filePath); } catch {}
    throw new Error(
      `❌ yt-dlp returned an audio file (.${ext}) instead of video. ` +
      `This URL may not have a downloadable video. Try a different link.`
    );
  }
  const stat = fs.statSync(filePath);
  return { filePath, fileName: path.basename(filePath), ext, size: stat.size, platform: "youtube" };
}

export interface YtDlpSummary {
  tried: number;
  walled: number;
}

let _lastSummary: YtDlpSummary = { tried: 0, walled: 0 };
export function getLastYtDlpSummary(): YtDlpSummary {
  return { ..._lastSummary };
}

export async function downloadYouTubeViaYtDlp(
  url: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult | null> {
  if (!config.youtubeYtdlpFallback) return null;
  if (!ytDlpAvailable()) {
    console.warn(`⚠️ YouTube yt-dlp fallback skipped: binary not found at "${config.ytDlpPath}"`);
    return null;
  }
  if (!fs.existsSync(config.downloadDir)) fs.mkdirSync(config.downloadDir, { recursive: true });

  const id = crypto.randomBytes(6).toString("hex");
  const template = path.join(config.downloadDir, `${id}_%(title).100s.%(ext)s`);
  const baseArgs: string[] = [
    "--no-playlist",
    "--no-warnings",
    "--merge-output-format", "mp4",
    "--ffmpeg-location", config.ffmpegDir,
    "--downloader-args", "ffmpeg:-threads 0",
    "--max-filesize", `${config.maxFileSizeMB}M`,
    "-o", template,
    "--no-mtime",
  ];

  const attempts = attemptsForYouTube();
  const summary: YtDlpSummary = { tried: 0, walled: 0 };
  let lastError = "";
  for (const attempt of attempts) {
    summary.tried++;
    const args = [
      ...baseArgs,
      ...buildYoutubeArgs(attempt.playerClient, formatFor(attempt.playerClient), attempt.useCookies),
      "--print", "after_move:filepath",
      url,
    ];
    try {
      console.log(`⏳ YouTube yt-dlp attempt: ${attempt.name}${attempt.useCookies ? " (cookies)" : " (anonymous)"}…`);
      const stdout = await runYtDlpAttempt(args, onProgress);
      const result = resolveDownloadedFile(stdout, id);
      _lastSummary = summary;
      console.log(`✅ YouTube yt-dlp saved via ${attempt.name}: ${result.fileName} (${(result.size / 1048576).toFixed(1)} MB)`);
      return result;
    } catch (err: any) {
      lastError = err?.message || String(err);
      if (lastError.startsWith("❌")) throw err; // definitive (too large / audio-only)
      if (isBotCheck(lastError)) summary.walled++;
      console.warn(`⚠️ YouTube yt-dlp "${attempt.name}" failed: ${lastError.slice(0, 180)}`);
      if (isFatalError(lastError)) {
        _lastSummary = summary;
        if (lastError.includes("max-filesize") || lastError.includes("File is larger than")) {
          throw new Error(`❌ Video too large (>${config.maxFileSizeMB}MB). Try a shorter video.`);
        }
        if (lastError.includes("Unsupported URL")) {
          throw new Error("❌ Unsupported URL. Make sure the link is a public video.");
        }
        if (/Private video|This video is private|Video unavailable/.test(lastError)) {
          throw new Error("❌ Video unavailable or private.");
        }
        throw new Error("❌ Video unavailable or private.");
      }
    }
  }
  _lastSummary = summary;
  console.warn(`⚠️ All YouTube yt-dlp attempts failed (${summary.tried} tried, ${summary.walled} bot-walled). Last: ${lastError.slice(0, 150)}`);
  return null;
}
