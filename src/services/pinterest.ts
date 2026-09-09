import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { config } from "../config";
import type { DownloadProgress, DownloadResult } from "./downloader";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Extract the numeric pin ID from any Pinterest URL form. */
export function extractPinId(url: string): string | null {
  const m = url.match(/\/pin\/(\d+)/i);
  if (m) return m[1];
  // Raw numeric ID pasted directly.
  const raw = url.trim().match(/^(\d{5,})$/);
  if (raw) return raw[1];
  return null;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "pinterest";
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function pickMeta(html: string, property: string): string | null {
  // <meta property="og:video" content="..."> (attribute order may vary)
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, "i"),
    new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeHtmlEntities(m[1]);
  }
  return null;
}

function extFromUrl(fileUrl: string, fallback: string): string {
  try {
    const clean = fileUrl.split("?")[0].split("#")[0];
    const ext = path.extname(clean).slice(1).toLowerCase();
    if (/^[a-z0-9]{2,5}$/.test(ext)) return ext;
  } catch {}
  return fallback;
}

async function fetchHtml(url: string, timeoutMs = 30000): Promise<{ html: string; finalUrl: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      if (res.status === 404) throw new Error("❌ Pin not found. It may be deleted, private, or the link is wrong.");
      throw new Error(`Pinterest page HTTP ${res.status}`);
    }
    return { html: await res.text(), finalUrl: res.url || url };
  } catch (err: any) {
    if (err?.message?.startsWith("❌")) throw err;
    if (err?.name === "AbortError") throw new Error("❌ Pinterest timed out. Please try again.");
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timeout);
  }
}

async function streamToFile(
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
      headers: { "User-Agent": UA, Referer: referer },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Media server HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length") || 0);
    if (total > maxBytes) {
      throw new Error(`❌ File too large (>${config.maxFileSizeMB}MB). Try another pin.`);
    }
    const file = fs.createWriteStream(filePath);
    let received = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.length;
        if (received > maxBytes) {
          file.destroy();
          try { fs.unlinkSync(filePath); } catch {}
          throw new Error(`❌ File too large (>${config.maxFileSizeMB}MB). Try another pin.`);
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
    if (err?.name === "AbortError") throw new Error("❌ Pinterest download timed out. Please try again.");
    throw err instanceof Error ? err : new Error(`❌ Pinterest download failed: ${err}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Pinterest download without any login, cookies, or yt-dlp.
 *
 * Handles pin.it short links (redirects followed), video pins (og:video /
 * embedded video_list JSON) and image pins (og:image fallback). The direct
 * v1.pinimg.com file URLs are downloaded with plain HTTPS.
 *
 * Throws user-facing errors (❌…) when the pin is gone/private.
 */
export async function downloadPinterest(
  url: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult> {
  const { html, finalUrl } = await fetchHtml(url);
  const pinId = extractPinId(finalUrl) || extractPinId(url);

  const title =
    pickMeta(html, "og:title") ||
    html.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1]?.trim() ||
    (pinId ? `pinterest_${pinId}` : "pinterest");

  // --- 1) Video: og:video meta (most reliable) ---------------------------
  let videoUrl =
    pickMeta(html, "og:video:url") ||
    pickMeta(html, "og:video:secure_url") ||
    pickMeta(html, "og:video") ||
    pickMeta(html, "twitter:player:stream");

  // --- 2) Video: embedded video_list JSON (V_720P preferred) --------------
  if (!videoUrl) {
    // e.g. "video_list":{"V_720P":{"url":"https://v1.pinimg.com/...mp4",...},...}
    const lists = [...html.matchAll(/"video_list"\s*:\s*\{([^{}]*\{[^{}]*\}[^{}]*)*\}/g)];
    const candidates: string[] = [];
    for (const m of lists) {
      for (const u of m[0].matchAll(/"url"\s*:\s*"([^"]+?\.mp4[^"]*)"/g)) {
        candidates.push(u[1].replace(/\\u0026/g, "&").replace(/\\/g, ""));
      }
    }
    // Prefer 720p rendition, else first mp4 found.
    videoUrl =
      candidates.find((c) => /720|720p/i.test(c)) ||
      candidates.find((c) => c.includes("pinimg.com") || c.includes("pinimg")) ||
      candidates[0] ||
      null;
  }

  if (!fs.existsSync(config.downloadDir)) fs.mkdirSync(config.downloadDir, { recursive: true });
  const id = crypto.randomBytes(6).toString("hex");
  const base = sanitizeFileName(decodeHtmlEntities(title).replace(/\s*\|\s*Pinterest\s*$/i, ""));

  if (videoUrl) {
    const fileName = `${id}_${base}.mp4`;
    const filePath = path.join(config.downloadDir, fileName);
    console.log(`📌 Pinterest video found for pin ${pinId || "?"} — downloading direct MP4…`);
    await streamToFile(videoUrl, filePath, "https://www.pinterest.com/", onProgress);
    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      try { fs.unlinkSync(filePath); } catch {}
      throw new Error("❌ Pinterest returned an empty file. Try another pin.");
    }
    console.log(`✅ Pinterest saved: ${fileName} (${(stat.size / 1048576).toFixed(1)} MB)`);
    return { filePath, fileName, title: base, ext: "mp4", size: stat.size, platform: "pinterest" };
  }

  // --- 3) Image pin fallback (og:image) -----------------------------------
  const imageUrl = pickMeta(html, "og:image:secure_url") || pickMeta(html, "og:image");
  if (imageUrl && !/default|avatar|logo/i.test(imageUrl)) {
    const ext = extFromUrl(imageUrl, "jpg");
    const fileName = `${id}_${base}.${ext}`;
    const filePath = path.join(config.downloadDir, fileName);
    console.log(`📌 Pinterest image found for pin ${pinId || "?"} — downloading…`);
    await streamToFile(imageUrl, filePath, "https://www.pinterest.com/", onProgress);
    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      try { fs.unlinkSync(filePath); } catch {}
      throw new Error("❌ Pinterest returned an empty file. Try another pin.");
    }
    console.log(`✅ Pinterest saved: ${fileName} (${(stat.size / 1048576).toFixed(1)} MB)`);
    return { filePath, fileName, title: base, ext, size: stat.size, platform: "pinterest" };
  }

  throw new Error(
    "❌ Could not find downloadable media in this Pinterest link. Make sure the pin is public (boards/sections need the direct pin URL, e.g. pinterest.com/pin/123…)."
  );
}
