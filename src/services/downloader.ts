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

const AUDIO_EXTENSIONS = new Set(["m4a", "mp3", "ogg", "opus", "wav", "aac", "flac", "wma"]);

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

  const args: string[] = [
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
  ];

  // Platform-specific format selectors
  // YouTube DASH: video-only + audio-only streams → merge into one mp4 (needs ffmpeg)
  // TikTok/IG/Twitter: muxed mp4 files → single stream, no merge needed
  if (platform === "youtube") {
    args.push("-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba");
  } else if (platform === "tiktok" || platform === "instagram" || platform === "twitter") {
    args.push("-f", "b[ext=mp4]/b");
  } else {
    args.push("-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best");
  }

  // Use --print to get final file path
  args.push("--print", "after_move:filepath", url);

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
        const msg = stderr || stdout || `yt-dlp exited with code ${code}`;
        if (msg.includes("Unsupported URL")) return reject(new Error("❌ Unsupported URL. Make sure the link is a public video."));
        if (msg.includes("Video unavailable")) return reject(new Error("❌ Video unavailable or private."));
        if (msg.includes("max-filesize")) return reject(new Error(`❌ Video too large (>${config.maxFileSizeMB}MB). Try a shorter video.`));
        if (msg.includes("Requested format is not available")) return reject(new Error("❌ Requested format not available."));
        const short = msg.slice(0, 800);
        return reject(new Error(`❌ Download failed:\n${short}`));
      }

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
        return reject(new Error("Download completed but file not found. Check yt-dlp output."));
      }

      const ext = path.extname(filePath).slice(1).toLowerCase() || "mp4";

      // GUARD: reject audio-only files
      if (AUDIO_EXTENSIONS.has(ext)) {
        fs.unlinkSync(filePath);
        return reject(
          new Error(
            `❌ yt-dlp returned an audio file (.${ext}) instead of video. ` +
            `This URL may not have a downloadable video. Try a different link.`
          )
        );
      }

      const stat = fs.statSync(filePath);
      const fileName = path.basename(filePath);

      resolve({
        filePath,
        fileName,
        ext,
        size: stat.size,
        platform,
      });
    });
  });
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
