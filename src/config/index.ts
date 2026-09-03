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
  // TikTok fallback: when yt-dlp fails (IP blocks / API changes),
  // resolve the video through a third-party API and download the mp4 directly.
  tiktokFallback: (process.env.TIKTOK_FALLBACK || "true").toLowerCase() !== "false",
};

export function isAdmin(userId: number): boolean {
  return config.adminIds.includes(userId);
}
