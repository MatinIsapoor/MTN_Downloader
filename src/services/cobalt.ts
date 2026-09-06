import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { config } from "../config";
import type { DownloadProgress, DownloadResult } from "./downloader";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function isCobaltConfigured(): boolean {
  return config.cobaltApiUrl.length > 0;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "video";
}

interface CobaltResponse {
  status?: string;
  url?: string;
  filename?: string;
  picker?: Array<{ url?: string; type?: string }>;
  error?: { code?: string };
}

/** Stream a remote file to disk with max-size enforcement + progress. */
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
      headers: { "User-Agent": UA },
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
 * Cobalt API path (optional, all platforms).
 *
 * Needs a SELF-HOSTED instance (COBALT_API_URL) — the public cobalt.tools
 * instance is blocked for YouTube since 2025, so there is no usable default.
 * When configured, Cobalt resolves the URL into a direct tunnel/redirect MP4
 * (single file, no ffmpeg merge = fast) and we stream it with plain HTTPS.
 *
 * API: POST {instance}/ with {url, videoQuality, downloadMode, filenameStyle}
 * (imputnet/cobalt v10+). Auth: `Authorization: Api-Key <key>` when set.
 *
 * Returns null when Cobalt can't resolve (caller falls back to next method).
 * Throws user-facing errors (❌…) for definitive failures.
 */
export async function downloadViaCobalt(
  url: string,
  platform: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult | null> {
  if (!isCobaltConfigured()) return null;

  const quality = config.youtubeMaxHeight >= 1080 ? "1080" : config.youtubeMaxHeight >= 720 ? "720" : "480";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let data: CobaltResponse;
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": UA,
    };
    if (config.cobaltApiKey) headers.Authorization = `Api-Key ${config.cobaltApiKey}`;
    const res = await fetch(config.cobaltApiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        url,
        videoQuality: quality,
        downloadMode: "auto",
        filenameStyle: "basic",
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Cobalt API HTTP ${res.status}`);
    data = (await res.json()) as CobaltResponse;
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.warn("⚠️ Cobalt API timed out, falling back…");
      return null;
    }
    console.warn(`⚠️ Cobalt API failed: ${(err?.message || String(err)).slice(0, 130)} — falling back…`);
    return null;
  } finally {
    clearTimeout(timeout);
  }

  if (data?.error) {
    const code = String(data.error?.code || "error");
    console.warn(`⚠️ Cobalt error: ${code} — falling back…`);
    // Definitive: content itself is gone.
    if (/not_found|private|deleted|unavailable|no_results/i.test(code)) {
      throw new Error("❌ Video unavailable or private.");
    }
    return null;
  }

  let fileUrl: string | undefined = data?.url;
  if (!fileUrl && Array.isArray(data?.picker)) {
    fileUrl = data.picker.find((p) => p?.url)?.url || data.picker[0]?.url;
  }
  if (!fileUrl) {
    console.warn(`⚠️ Cobalt returned status=${data?.status || "?"} with no URL — falling back…`);
    return null;
  }

  console.log(`⚡ Cobalt resolved (${data.status || "tunnel"}), downloading direct MP4…`);
  const id = crypto.randomBytes(6).toString("hex");
  const base = sanitizeFileName(data.filename?.replace(/\.[a-z0-9]+$/i, "") || platform);
  const fileName = `${id}_${base}.mp4`;
  const filePath = path.join(config.downloadDir, fileName);
  if (!fs.existsSync(config.downloadDir)) fs.mkdirSync(config.downloadDir, { recursive: true });

  await streamToFile(fileUrl, filePath, onProgress);
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    try {
      fs.unlinkSync(filePath);
    } catch {}
    throw new Error("❌ Download returned an empty file. Try another link.");
  }
  console.log(`✅ Cobalt saved: ${fileName} (${(stat.size / 1048576).toFixed(1)} MB)`);
  return { filePath, fileName, ext: "mp4", size: stat.size, platform };
}
