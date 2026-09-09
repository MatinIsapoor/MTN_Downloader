import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { config } from "../config";
import { extractYouTubeId } from "./invidious";
import type { DownloadProgress, DownloadResult } from "./downloader";

/**
 * Direct youtubei ANDROID player API.
 *
 * NOTE: this uses OUR OWN server IP (unlike Piped/Invidious, which use
 * theirs), so it wins a different per-(video, IP) lottery draw with YouTube's
 * bot-wall. Client version matters enormously: ANDROID 19.x returns nothing
 * at all anymore (YouTube killed it), while 20.10.38 with a full MOBILE
 * context returns playability=OK + progressive itag 18/22 for unwalled
 * videos. Verified Sep 2026.
 */

const KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const ANDROID_UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";

interface YoutubeiFormat {
  itag?: number;
  url?: string;
  signatureCipher?: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

interface YoutubeiResponse {
  playabilityStatus?: { status?: string; reason?: string };
  streamingData?: { formats?: YoutubeiFormat[]; adaptiveFormats?: YoutubeiFormat[] };
  videoDetails?: { title?: string };
}

function pickProgressive(formats: YoutubeiFormat[], maxHeight: number): YoutubeiFormat | null {
  // Direct `url` only — signatureCipher needs player-JS deciphering (that's
  // yt-dlp's job; we deliberately don't do it here).
  const direct = formats.filter(
    (f) => f.url && (f.mimeType || "").includes("video/mp4")
  );
  if (direct.length === 0) return null;
  const withH = direct.map((f) => ({ f, h: f.height || 0 }));
  if (maxHeight > 0) {
    const fitting = withH.filter((x) => x.h > 0 && x.h <= maxHeight).sort((a, b) => b.h - a.h);
    if (fitting.length > 0) return fitting[0].f;
    const smallest = withH.filter((x) => x.h > 0).sort((a, b) => a.h - b.h);
    if (smallest.length > 0) return smallest[0].f;
  } else {
    const known = withH.filter((x) => x.h > 0).sort((a, b) => b.h - a.h);
    if (known.length > 0) return known[0].f;
  }
  return direct[0];
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "video";
}

async function streamToFile(
  fileUrl: string,
  filePath: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<void> {
  const maxBytes = config.maxFileSizeMB * 1024 * 1024;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    const res = await fetch(fileUrl, {
      headers: { "User-Agent": ANDROID_UA },
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
    if (err?.name === "AbortError") throw new Error("❌ Download timed out. Please try again.");
    throw err instanceof Error ? err : new Error(`❌ Download failed: ${err}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Cookie-free YouTube last resort: talk to YouTube's player API directly as
 * an Android device. No yt-dlp, no cookies, no third party — just one HTTPS
 * POST from our own IP and a plain download of the returned itag 18/22
 * progressive MP4 (typically 360p, ideal for Telegram's size limits).
 *
 * Returns null when YouTube walls our IP for this video (caller reports).
 * Throws user-facing errors (❌…) for definitive failures (too large).
 */
export async function downloadYouTubeViaAndroid(
  url: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult | null> {
  const videoId = extractYouTubeId(url);
  if (!videoId) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let data: YoutubeiResponse;
  try {
    const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${KEY}&prettyPrint=false`, {
      method: "POST",
      headers: {
        "User-Agent": ANDROID_UA,
        "Content-Type": "application/json",
        Origin: "https://www.youtube.com",
      },
      body: JSON.stringify({
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "20.10.38",
            androidSdkVersion: 30,
            osName: "Android",
            osVersion: "11",
            platform: "MOBILE",
            hl: "en",
            gl: "US",
          },
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`youtubei HTTP ${res.status}`);
    data = (await res.json()) as YoutubeiResponse;
  } finally {
    clearTimeout(timeout);
  }

  const status = data?.playabilityStatus?.status;
  if (status !== "OK") {
    const reason = (data?.playabilityStatus?.reason || status || "unplayable").slice(0, 120);
    console.warn(`⚠️ Android direct: ${videoId} -> ${status}: ${reason}`);
    // Surface the wall verbatim so youtube.ts can classify it (bot-wall vs gone).
    throw new Error(`${status}: ${reason}`);
  }

  const formats = data?.streamingData?.formats || [];
  const chosen = pickProgressive(formats, config.youtubeMaxHeight);
  if (!chosen?.url) {
    throw new Error("no progressive mp4 stream (login-walled or gone?)");
  }

  const title = data?.videoDetails?.title || videoId;
  console.log(`⚡ Android direct: "${title.slice(0, 60)}" -> itag ${chosen.itag} (${chosen.height || "?"}p) progressive MP4`);

  const id = crypto.randomBytes(6).toString("hex");
  const fileName = `${id}_${sanitizeFileName(title)}.mp4`;
  const filePath = path.join(config.downloadDir, fileName);
  if (!fs.existsSync(config.downloadDir)) fs.mkdirSync(config.downloadDir, { recursive: true });

  await streamToFile(chosen.url, filePath, onProgress);
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    try { fs.unlinkSync(filePath); } catch {}
    throw new Error("empty file");
  }
  console.log(`✅ Android direct saved: ${fileName} (${(stat.size / 1048576).toFixed(1)} MB)`);
  return { filePath, fileName, title, ext: "mp4", size: stat.size, platform: "youtube" };
}
