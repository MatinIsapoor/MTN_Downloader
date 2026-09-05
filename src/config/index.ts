import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config();

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const config = {
  botToken: requireEnv("BOT_TOKEN"),
  adminIds: (process.env.ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !isNaN(n)),
  ytDlpPath: process.env.YT_DLP_PATH || "yt-dlp",
  ffmpegDir: process.env.FFMPEG_PATH
    ? path.resolve(path.dirname(process.env.FFMPEG_PATH))
    : path.resolve("."),
  maxFileSizeMB: Number(process.env.MAX_FILE_SIZE_MB || 50),
  downloadDir: path.resolve(process.env.DOWNLOAD_DIR || "./downloads"),
  databasePath: path.resolve(process.env.DATABASE_PATH || "./data/bot.db"),
  // YouTube bot-check bypass: cookies from a logged-in browser.
  // Either point to a Netscape-format cookies file, or let yt-dlp read
  // cookies directly from a browser (e.g. "chrome", "firefox", "edge").
  cookiesPath: path.resolve(process.env.COOKIES_PATH || "./cookies.txt"),
  cookiesFromBrowser: (process.env.COOKIES_FROM_BROWSER || "").trim(),
  // COOKIES_CONTENT: paste the full text of cookies.txt into an env var.
  // REQUIRED on hosts with an ephemeral filesystem (Render free plan wipes
  // uploaded files on every restart/redeploy). When set, the bot rewrites
  // cookiesPath from this value on every boot, so sessions survive restarts.
  // Accepts raw Netscape text OR base64-encoded text (safer for dashboards).
  cookiesContent: (process.env.COOKIES_CONTENT || "").trim(),
  // TikTok fallback: when yt-dlp fails (IP blocks / API changes),
  // resolve the video through a third-party API and download the mp4 directly.
  tiktokFallback: (process.env.TIKTOK_FALLBACK || "true").toLowerCase() !== "false",
  // YouTube without cookies: "auto" (default) tries anonymous player clients
  // (android/mweb/web_safari/web_embedded, no login) FIRST and only uses cookies as a
  // fallback for age-gated/private/rate-limited videos. Most public videos
  // then work with no cookies uploaded at all. Set to "cookies" to force the
  // old behavior (cookies first), or "never" to never touch cookies.
  youtubeCookieMode: (() => {
    const v = (process.env.YOUTUBE_COOKIE_MODE || "auto").trim().toLowerCase();
    return v === "cookies" || v === "never" ? v : "auto";
  })(),
  // Cap YouTube quality (default 720). Telegram caps bots at 50MB and 720p
  // is 3-5x smaller than 1080p+, so this is the single biggest download +
  // upload speedup. Set YOUTUBE_MAX_HEIGHT=1080 (or 2160) for full quality.
  youtubeMaxHeight: Number(process.env.YOUTUBE_MAX_HEIGHT || 720),
  // Optional proxy for yt-dlp (e.g. a residential HTTP(S)/SOCKS5 proxy).
  // Datacenter IPs (Render/AWS/GCP) get YouTube's strictest bot-checks; a
  // residential proxy is the only fix when the IP itself is flagged.
  // Example: YT_DLP_PROXY=http://user:pass@host:port
  ytDlpProxy: (process.env.YT_DLP_PROXY || "").trim(),
};

export function isAdmin(userId: number): boolean {
  return config.adminIds.includes(userId);
}
