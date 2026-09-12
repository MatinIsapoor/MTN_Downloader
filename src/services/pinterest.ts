import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { config } from "../config";
import type { DownloadProgress, DownloadResult } from "./downloader";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Extract the numeric pin ID from any Pinterest URL form. */
export function extractPinId(url: string): string | null {
  // Standard: /pin/123…/ — plus slug form: /pin/<title-slug>--123…/
  // (e.g. pinterest.com/pin/dive-into-serenity-…-video-in-2024--2885187256207927/)
  const m = url.match(/\/pin\/(?:[^/?#]*?--)?(\d+)/i);
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

/**
 * Fetch pin metadata through Pinterest's own PinResource API — the same
 * endpoint yt-dlp uses. Works anonymously (no login/cookies) and returns
 * the native `videos.video_list` renditions plus `story_pin_data` pages,
 * which the public pin HTML page no longer embeds for bots (it only carries
 * the og:image thumbnail — the reason video pins were saved as images).
 */
async function fetchPinData(pinId: string): Promise<any> {
  const dataParam = JSON.stringify({
    options: { field_set_key: "unauth_react_main_pin", id: pinId },
  });
  const apiUrl = `https://www.pinterest.com/resource/PinResource/get/?data=${encodeURIComponent(dataParam)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(apiUrl, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "en-US,en;q=0.9",
        "X-Pinterest-PWS-Handler": "www/[username].js",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `https://www.pinterest.com/pin/${pinId}/`,
      },
      signal: controller.signal,
    });
    if (res.status === 404) {
      throw new Error("❌ Pin not found. It may be deleted, private, or the link is wrong.");
    }
    if (!res.ok) throw new Error(`PinResource HTTP ${res.status}`);
    const json: any = await res.json();
    const rr = json?.resource_response;
    if (!rr || rr.data == null) {
      const msg = String(rr?.error?.message || "");
      if (rr?.error?.http_status === 404 || rr?.error?.code === 50 || /not found/i.test(msg)) {
        throw new Error("❌ Pin not found. It may be deleted, private, or the link is wrong.");
      }
      throw new Error(`PinResource error: ${msg || rr?.error?.code || "empty response"}`);
    }
    return rr.data;
  } catch (err: any) {
    if (err?.message?.startsWith("❌")) throw err;
    if (err?.name === "AbortError") throw new Error("PinResource timed out");
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timeout);
  }
}

interface PinMp4Candidate {
  url: string;
  width: number;
  height: number;
  formatId: string;
}

/** Collect progressive (.mp4) renditions from native video + story-pin blocks. */
function collectMp4Candidates(data: any): PinMp4Candidate[] {
  const out: PinMp4Candidate[] = [];
  const pushList = (list: any): void => {
    if (!list || typeof list !== "object") return;
    for (const [formatId, f] of Object.entries<any>(list)) {
      const u = typeof (f as any)?.url === "string" ? (f as any).url : null;
      if (!u || !/^https?:\/\//i.test(u)) continue;
      // Skip HLS playlists — the yt-dlp fallback handles those.
      if (!/\.mp4(\?|#|$)/i.test(u)) continue;
      out.push({
        url: u.replace(/\\u0026/g, "&"),
        width: Number((f as any)?.width) || 0,
        height: Number((f as any)?.height) || 0,
        formatId: String(formatId),
      });
    }
  };
  pushList(data?.videos?.video_list);
  const pages = data?.story_pin_data?.pages;
  if (Array.isArray(pages)) {
    for (const p of pages) {
      const blocks = (p as any)?.blocks;
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) pushList((b as any)?.video?.video_list);
    }
  }
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)));
}

/** Prefer Pinterest's canonical 720p progressive rendition, else largest frame. */
function pickBestMp4(candidates: PinMp4Candidate[]): string | null {
  if (candidates.length === 0) return null;
  const score = (e: PinMp4Candidate): number => {
    const id = e.formatId.toUpperCase();
    let s = (e.width || 0) * (e.height || 0);
    if (id === "V_720P") s += 1e12;
    else if (/720|1080/.test(id)) s += 1e11;
    return s;
  };
  return [...candidates].sort((a, b) => score(b) - score(a))[0].url;
}

/** Best-quality image from API metadata (original first, else largest). */
function pickApiImage(data: any): string | null {
  const images = data?.images;
  if (!images || typeof images !== "object") return null;
  const orig = (images as any)?.orig?.url;
  if (typeof orig === "string" && /^https?:\/\//i.test(orig)) return orig;
  let best: string | null = null;
  let bestArea = -1;
  for (const v of Object.values<any>(images)) {
    const u = (v as any)?.url;
    if (typeof u !== "string" || !/^https?:\/\//i.test(u)) continue;
    if (!/\.(jpe?g|png|webp|gif)(\?|#|$)/i.test(u.split("?")[0])) continue;
    const area = (Number((v as any)?.width) || 0) * (Number((v as any)?.height) || 0);
    if (area >= bestArea) {
      bestArea = area;
      best = u;
    }
  }
  return best;
}

function pinTitle(data: any, pinId: string | null): string {
  const raw = (data?.title || data?.grid_title || "").trim();
  if (raw) return raw;
  return pinId ? `pinterest_${pinId}` : "pinterest";
}

/** True when the API metadata describes a video pin (even if no mp4 was listed). */
function looksLikeVideoPin(data: any, mp4Count: number): boolean {
  return Boolean(
    mp4Count > 0 ||
      data?.is_video ||
      data?.is_playable ||
      data?.videos ||
      data?.story_pin_data ||
      (data?.domain && String(data.domain).toLowerCase() !== "uploaded by user" && data?.embed?.src)
  );
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
 * Primary path is Pinterest's own PinResource API (same source yt-dlp
 * reads): it returns the native video renditions even though the public
 * HTML page no longer embeds them for bots. HTML meta scraping stays as a
 * secondary path, and og:image is strictly a last resort for genuine image
 * pins — a pin that looks like video but yields no direct mp4 throws (so
 * the caller can try yt-dlp) instead of silently returning the thumbnail.
 *
 * Throws user-facing errors (❌…) when the pin is gone/private.
 */
export async function downloadPinterest(
  url: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult> {
  if (!fs.existsSync(config.downloadDir)) fs.mkdirSync(config.downloadDir, { recursive: true });

  // --- Resolve the pin ID (pin.it short links need one page fetch) ---------
  let pinId = extractPinId(url);
  let html: string | null = null;
  let finalUrl = url;
  if (!pinId) {
    const fetched = await fetchHtml(url);
    html = fetched.html;
    finalUrl = fetched.finalUrl;
    pinId = extractPinId(finalUrl);
  }

  const saveVideo = async (videoUrl: string, base: string): Promise<DownloadResult> => {
    const id = crypto.randomBytes(6).toString("hex");
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
  };

  const saveImage = async (imageUrl: string, base: string): Promise<DownloadResult> => {
    const id = crypto.randomBytes(6).toString("hex");
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
  };

  // --- 1) Video via PinResource API (most reliable) -------------------------
  if (pinId) {
    let data: any = null;
    try {
      data = await fetchPinData(pinId);
    } catch (err: any) {
      // Gone/private: definitive, no point scraping further.
      if (err?.message?.startsWith("❌")) throw err;
      console.warn(`⚠️ Pinterest API failed for pin ${pinId}, trying page scrape: ${(err?.message || String(err)).slice(0, 130)}`);
    }
    if (data) {
      const base = sanitizeFileName(decodeHtmlEntities(pinTitle(data, pinId)).replace(/\s*\|\s*Pinterest\s*$/i, ""));
      const best = pickBestMp4(collectMp4Candidates(data));
      if (best) return saveVideo(best, base);

      if (looksLikeVideoPin(data, 0)) {
        // Video pin, but no progressive mp4 (HLS-only rendition or an
        // external YouTube/Vimeo embed): yt-dlp knows how to handle these,
        // so fall through to it instead of returning the cover thumbnail.
        // The cover is still saved and attached as a last-resort fallback in
        // case yt-dlp can't get the video either.
        // Plain (non-❌) error => downloader.ts continues to yt-dlp.
        let coverFallback: DownloadResult | null = null;
        try {
          const cover = pickApiImage(data);
          if (cover && !/default|avatar|logo/i.test(cover)) {
            coverFallback = await saveImage(cover, base);
          }
        } catch {}
        const err: any = new Error(
          "Pinterest video has no direct mp4 (HLS-only or external embed) — needs yt-dlp fallback"
        );
        if (coverFallback) err.pinterestImageFallback = coverFallback;
        throw err;
      }

      const apiImage = pickApiImage(data);
      if (apiImage && !/default|avatar|logo/i.test(apiImage)) {
        return saveImage(apiImage, base);
      }
      // No video, no usable API image — fall through to page scrape below.
    }
  }

  // --- 2) Page scrape (also resolves pin.it / slug URLs) --------------------
  if (!html) {
    const fetched = await fetchHtml(url);
    html = fetched.html;
    finalUrl = fetched.finalUrl;
    pinId = extractPinId(finalUrl) || pinId;
  }

  const title =
    pickMeta(html, "og:title") ||
    html.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1]?.trim() ||
    (pinId ? `pinterest_${pinId}` : "pinterest");

  // --- 2a) Video: og:video meta --------------------------------------------
  let videoUrl =
    pickMeta(html, "og:video:url") ||
    pickMeta(html, "og:video:secure_url") ||
    pickMeta(html, "og:video") ||
    pickMeta(html, "twitter:player:stream");

  // --- 2b) Video: embedded video_list JSON (V_720P preferred) ---------------
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

  // --- 2c) Video: any direct v1.pinimg.com mp4 in the page ------------------
  if (!videoUrl) {
    const unescaped = html.replace(/\\\//g, "/").replace(/\\u0026/gi, "&");
    const direct = [...unescaped.matchAll(/https?:\/\/v1\.pinimg\.com\/videos\/[^"'\\\s]+\.mp4[^"'\\\s]*/gi)]
      .map((m) => m[0])
      .find((u) => !/thumbnail/i.test(u));
    if (direct) {
      console.log("📌 Pinterest video found via page mp4 scan…");
      videoUrl = direct;
    }
  }

  const base = sanitizeFileName(decodeHtmlEntities(title).replace(/\s*\|\s*Pinterest\s*$/i, ""));

  if (videoUrl) {
    return saveVideo(videoUrl, base);
  }

  // --- 3) Image pin fallback (og:image) -------------------------------------
  // Only reached when the API path above did NOT classify this pin as video,
  // so returning the image here is correct (genuine image pin).
  const imageUrl = pickMeta(html, "og:image:secure_url") || pickMeta(html, "og:image");
  if (imageUrl && !/default|avatar|logo/i.test(imageUrl)) {
    return saveImage(imageUrl, base);
  }

  throw new Error(
    "❌ Could not find downloadable media in this Pinterest link. Make sure the pin is public (boards/sections need the direct pin URL, e.g. pinterest.com/pin/123…)."
  );
}
