import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { config } from "../config";
import type { DownloadProgress, DownloadResult } from "./downloader";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Extract the 11-char YouTube video ID from any common URL form. */
export function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id! : null;
    }
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      // /watch?v=ID
      const v = u.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      // /shorts/ID, /embed/ID, /live/ID, /v/ID, /short/ID
      const m = u.pathname.match(/\/(?:shorts|embed|live|v|short)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
  } catch {}
  // Fallback: raw ID or regex scan.
  const m = url.match(/([A-Za-z0-9_-]{11})/);
  if (m && /(?:youtube|youtu\.be|shorts|watch)/i.test(url)) return m[1];
  return null;
}

interface InvidiousFormat {
  url?: string;
  itag?: string;
  type?: string;
  container?: string;
  qualityLabel?: string;
  resolution?: string;
  size?: string;
  encoding?: string;
}

function parseHeight(f: InvidiousFormat): number {
  const label = f.qualityLabel || f.resolution || "";
  const m = label.match(/(\d+)\s*p/i);
  if (m) return Number(m[1]);
  return 0;
}

function isMp4Progressive(f: InvidiousFormat): boolean {
  if (!f.url) return false;
  const t = (f.type || "").toLowerCase();
  const c = (f.container || "").toLowerCase();
  if (c === "mp4") return true;
  // type looks like 'video/mp4; codecs="avc1..., mp4a..."' for muxed streams.
  if (t.includes("video/mp4")) return true;
  return false;
}

/** Pick the best progressive MP4 at or under maxHeight (0 = uncapped). */
export function pickFormat(
  formats: InvidiousFormat[],
  maxHeight: number
): InvidiousFormat | null {
  const mp4s = formats.filter(isMp4Progressive);
  if (mp4s.length === 0) return null;
  const withHeight = mp4s.map((f) => ({ f, h: parseHeight(f) }));
  if (maxHeight > 0) {
    const fitting = withHeight.filter((x) => x.h > 0 && x.h <= maxHeight);
    if (fitting.length > 0) {
      fitting.sort((a, b) => b.h - a.h);
      return fitting[0].f;
    }
    // Nothing fits the cap (all higher): take the smallest available so the
    // file still fits Telegram limits instead of grabbing 1080p+.
    const known = withHeight.filter((x) => x.h > 0).sort((a, b) => a.h - b.h);
    if (known.length > 0) return known[0].f;
  } else {
    const known = withHeight.filter((x) => x.h > 0).sort((a, b) => b.h - a.h);
    if (known.length > 0) return known[0].f;
  }
  // No height info at all — just take the first mp4.
  return mp4s[0];
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "video";
}

/** Stream a remote file to disk with Telegram max-size enforcement + progress. */
async function streamToFile(
  fileUrl: string,
  filePath: string,
  referer: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<number> {
  const maxBytes = config.maxFileSizeMB * 1024 * 1024;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    const res = await fetch(fileUrl, {
      headers: { "User-Agent": UA, Referer: referer },
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
          try {
            fs.unlinkSync(filePath);
          } catch {}
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
    return received;
  } catch (err: any) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
    if (err?.name === "AbortError") throw new Error("❌ Download timed out. Please try again.");
    throw err instanceof Error ? err : new Error(`❌ Download failed: ${err}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fast YouTube path: resolve the progressive MP4 through a public Invidious
 * instance and download it with plain HTTPS.
 *
 * Why this is faster + more reliable than yt-dlp for YouTube:
 * - The instance (not our datacenter IP) talks to YouTube, so Render's
 *   IP-based "Sign in to confirm you're not a bot" checks don't apply.
 * - No JS-challenge solving, no cookies, no player-client roulette.
 * - The result is a single muxed MP4 — no DASH video+audio merge via ffmpeg,
 *   which is the slowest part of the yt-dlp path on small hosts.
 *
 * Returns null when every instance fails (caller falls back to yt-dlp).
 * Throws user-facing errors (❌…) for definitive failures (too large, gone).
 */
export async function downloadYouTubeViaInvidious(
  url: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult | null> {
  const videoId = extractYouTubeId(url);
  if (!videoId) return null;

  const failures: string[] = [];
  for (const instance of config.invidiousInstances) {
    try {
      const data = await fetchJsonWithTimeout(
        `${instance}/api/v1/videos/${videoId}`,
        15000
      );
      if (data?.error) throw new Error(String(data.error).slice(0, 120));
      const title: string | undefined = data?.title;
      const formats: InvidiousFormat[] = data?.formatStreams || [];
      if (!Array.isArray(formats) || formats.length === 0) {
        throw new Error("no progressive streams (login-walled or gone?)");
      }
      const chosen = pickFormat(formats, config.youtubeMaxHeight);
      if (!chosen?.url) throw new Error("no mp4 stream available");
      const height = parseHeight(chosen);
      console.log(
        `⚡ Invidious ${instance}: "${(title || videoId).slice(0, 60)}" ` +
          `-> ${chosen.qualityLabel || height + "p" || "mp4"} progressive MP4`
      );

      const id = crypto.randomBytes(6).toString("hex");
      const fileName = `${id}_${sanitizeFileName(title || videoId)}.mp4`;
      const filePath = path.join(config.downloadDir, fileName);
      if (!fs.existsSync(config.downloadDir)) fs.mkdirSync(config.downloadDir, { recursive: true });

      await streamToFile(chosen.url, filePath, `${instance}/`, onProgress);
      const stat = fs.statSync(filePath);
      if (stat.size === 0) {
        try {
          fs.unlinkSync(filePath);
        } catch {}
        throw new Error("empty file");
      }
      console.log(`✅ Invidious saved: ${fileName} (${(stat.size / 1048576).toFixed(1)} MB)`);
      return {
        filePath,
        fileName,
        title,
        ext: "mp4",
        size: stat.size,
        platform: "youtube",
      };
    } catch (err: any) {
      const msg = err?.message || String(err);
      // Definitive failures: don't burn through every instance.
      if (msg.startsWith("❌")) throw err;
      console.warn(`⚠️ Invidious ${instance} failed for ${videoId}: ${msg.slice(0, 130)}`);
      failures.push(`${instance}: ${msg.slice(0, 80)}`);
    }
  }
  console.warn(`⚠️ All Invidious instances failed: ${failures.join(" | ").slice(0, 300)}`);
  return null;
}
