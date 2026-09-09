import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { config } from "../config";
import { extractYouTubeId } from "./invidious";
import type { DownloadProgress, DownloadResult } from "./downloader";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

interface PipedVideoStream {
  url?: string;
  quality?: string;
  mimeType?: string;
  codec?: string;
  videoOnly?: boolean;
  container?: string;
  height?: number;
  width?: number;
}

interface PipedResponse {
  title?: string;
  videoStreams?: PipedVideoStream[];
  audioStreams?: unknown[];
  error?: string;
}

function parseHeight(s: PipedVideoStream): number {
  if (typeof s.height === "number" && s.height > 0) return s.height;
  const q = s.quality || "";
  const m = q.match(/(\d+)\s*p/i);
  return m ? Number(m[1]) : 0;
}

function isProgressiveMp4(s: PipedVideoStream): boolean {
  if (!s.url) return false;
  if (s.videoOnly === true) return false;
  const mime = (s.mimeType || "").toLowerCase();
  const container = (s.container || "").toLowerCase();
  if (container === "mp4") return true;
  if (mime.includes("video/mp4")) return true;
  return false;
}

/** Best progressive (audio+video) MP4 at or under maxHeight (0 = uncapped). */
export function pickPipedStream(
  streams: PipedVideoStream[],
  maxHeight: number
): PipedVideoStream | null {
  const mp4s = streams.filter(isProgressiveMp4);
  if (mp4s.length === 0) return null;
  const withHeight = mp4s.map((s) => ({ s, h: parseHeight(s) }));
  if (maxHeight > 0) {
    const fitting = withHeight.filter((x) => x.h > 0 && x.h <= maxHeight);
    if (fitting.length > 0) {
      fitting.sort((a, b) => b.h - a.h);
      return fitting[0].s;
    }
    const known = withHeight.filter((x) => x.h > 0).sort((a, b) => a.h - b.h);
    if (known.length > 0) return known[0].s;
  } else {
    const known = withHeight.filter((x) => x.h > 0).sort((a, b) => b.h - a.h);
    if (known.length > 0) return known[0].s;
  }
  return mp4s[0];
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "video";
}

async function streamToFile(
  fileUrl: string,
  filePath: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<number> {
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
    return received;
  } catch (err: any) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
    if (err?.name === "AbortError") throw new Error("❌ Download timed out. Please try again.");
    throw err instanceof Error ? err : new Error(`❌ Download failed: ${err}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Live backend discovery: the official Piped docs repo lists every known
 * public instance. Public backends die regularly (verified Sep 2026: 10 of
 * 17 known hosts dead), so merge the live list behind the configured one —
 * the bot self-heals without a redeploy when instances rotate.
 * Cached per process (6h); never throws (falls back to configured list).
 */
let _pipedCache: { at: number; list: string[] } | null = null;
async function resolvePipedInstances(): Promise<string[]> {
  const configured = config.pipedInstances;
  if (!config.pipedRefresh) return configured;
  const now = Date.now();
  if (_pipedCache && now - _pipedCache.at < 6 * 3600 * 1000) return _pipedCache.list;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let md = "";
    try {
      const res = await fetch(
        "https://raw.githubusercontent.com/TeamPiped/documentation/main/content/docs/public-instances/index.md",
        { headers: { "User-Agent": UA }, signal: controller.signal }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      md = await res.text();
    } finally {
      clearTimeout(timeout);
    }
    const discovered = [...new Set(
      [...md.matchAll(/https:\/\/[A-Za-z0-9.-]+/g)]
        .map((m) => m[0].replace(/\/+$/, ""))
        // Backend API hosts only — skip frontends (piped.video), github, etc.
        .filter((u) => /piped/i.test(u) && !u.includes("github"))
    )];
    const merged = [...new Set([...configured, ...discovered])];
    if (merged.length > 0) {
      _pipedCache = { at: now, list: merged.slice(0, 20) };
      if (discovered.length > 0) {
        console.log(`⚡ Piped: live discovery added ${discovered.length} known backends (${merged.length} total to try)`);
      }
      return _pipedCache.list;
    }
  } catch (err: any) {
    console.warn(`⚠️ Piped instance refresh failed, using configured list: ${(err?.message || String(err)).slice(0, 100)}`);
  }
  return configured;
}

/**
 * Cookie-free YouTube path: Piped API.
 *
 * Each public Piped backend instance proxies YouTube on its own IP, so this
 * bypasses datacenter "Sign in to confirm you're not a bot" walls —
 * plain HTTPS, no yt-dlp binary, no cookies, and the result is a single
 * progressive MP4 served through the instance's proxy (no ffmpeg merge).
 *
 * API: GET {instance}/streams/{videoId}
 *   -> { title, videoStreams: [{url, quality, mimeType, videoOnly, ...}] }
 *
 * Returns null when every instance fails (caller tries the next method).
 * Throws user-facing errors (❌…) for definitive failures (too large).
 */
export async function downloadYouTubeViaPiped(
  url: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult | null> {
  const videoId = extractYouTubeId(url);
  if (!videoId) return null;

  const instances = await resolvePipedInstances();
  const failures: string[] = [];
  for (const instance of instances) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      let data: PipedResponse;
      try {
        const res = await fetch(`${instance}/streams/${videoId}`, {
          headers: { "User-Agent": UA, Accept: "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = (await res.json()) as PipedResponse;
      } finally {
        clearTimeout(timeout);
      }
      if (data?.error) throw new Error(String(data.error).slice(0, 120));
      const streams = Array.isArray(data?.videoStreams) ? data.videoStreams! : [];
      const chosen = pickPipedStream(streams, config.youtubeMaxHeight);
      if (!chosen?.url) {
        throw new Error("no progressive mp4 stream (login-walled or gone?)");
      }
      const height = parseHeight(chosen);
      console.log(
        `⚡ Piped ${instance}: "${(data.title || videoId).slice(0, 60)}" ` +
          `-> ${chosen.quality || (height ? height + "p" : "mp4")} progressive MP4`
      );

      const id = crypto.randomBytes(6).toString("hex");
      const fileName = `${id}_${sanitizeFileName(data.title || videoId)}.mp4`;
      const filePath = path.join(config.downloadDir, fileName);
      if (!fs.existsSync(config.downloadDir)) fs.mkdirSync(config.downloadDir, { recursive: true });

      await streamToFile(chosen.url, filePath, onProgress);
      const stat = fs.statSync(filePath);
      if (stat.size === 0) {
        try { fs.unlinkSync(filePath); } catch {}
        throw new Error("empty file");
      }
      console.log(`✅ Piped saved: ${fileName} (${(stat.size / 1048576).toFixed(1)} MB)`);
      return { filePath, fileName, title: data.title, ext: "mp4", size: stat.size, platform: "youtube" };
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.startsWith("❌")) throw err;
      console.warn(`⚠️ Piped ${instance} failed for ${videoId}: ${msg.slice(0, 130)}`);
      failures.push(`${instance}: ${msg.slice(0, 80)}`);
    }
  }
  console.warn(`⚠️ All Piped instances failed: ${failures.join(" | ").slice(0, 300)}`);
  return null;
}
