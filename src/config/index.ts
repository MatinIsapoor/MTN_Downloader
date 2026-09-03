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
};

export function isAdmin(userId: number): boolean {
  return config.adminIds.includes(userId);
}
