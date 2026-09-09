import { config } from "../config";
import { downloadViaCobalt, isCobaltConfigured } from "./cobalt";
import { downloadYouTubeViaInvidious } from "./invidious";
import { downloadYouTubeViaPiped } from "./piped";
import type { DownloadProgress, DownloadResult } from "./downloader";

/**
 * Cookie-free YouTube download pipeline — NO yt-dlp, NO cookies.
 *
 * Order (all plain HTTPS, single progressive MP4, no ffmpeg merge):
 *   1. Cobalt API (only when self-hosted COBALT_API_URL is configured)
 *   2. Invidious (public instances, no setup)
 *   3. Piped API (federated network — survives blocks best in 2026)
 *
 * Each provider runs on ITS OWN server IP, so YouTube's datacenter
 * "Sign in to confirm you're not a bot" wall against our IP doesn't apply.
 * Throws a user-facing error (❌…) when every provider fails.
 */
export async function downloadYouTubeCookieFree(
  url: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult> {
  // --- 1) Cobalt (self-hosted, fastest when available) -------------------
  if (isCobaltConfigured()) {
    try {
      console.log("⚡ YouTube: trying Cobalt…");
      const fast = await downloadViaCobalt(url, "youtube", onProgress);
      if (fast) return fast;
    } catch (err: any) {
      if (err?.message?.startsWith("❌")) throw err;
      console.warn(`⚠️ YouTube Cobalt failed, continuing: ${(err?.message || String(err)).slice(0, 150)}`);
    }
  }

  // --- 2) Invidious -------------------------------------------------------
  if (config.invidiousEnabled) {
    try {
      console.log("⚡ YouTube: trying Invidious…");
      const fast = await downloadYouTubeViaInvidious(url, onProgress);
      if (fast) return fast;
      console.log("⚡ YouTube: Invidious unavailable for this video, trying Piped…");
    } catch (err: any) {
      if (err?.message?.startsWith("❌")) throw err;
      console.warn(`⚠️ YouTube Invidious failed, trying Piped: ${(err?.message || String(err)).slice(0, 150)}`);
    }
  }

  // --- 3) Piped -----------------------------------------------------------
  if (config.pipedEnabled) {
    try {
      console.log("⚡ YouTube: trying Piped…");
      const fast = await downloadYouTubeViaPiped(url, onProgress);
      if (fast) return fast;
    } catch (err: any) {
      if (err?.message?.startsWith("❌")) throw err;
      console.warn(`⚠️ YouTube Piped failed: ${(err?.message || String(err)).slice(0, 150)}`);
    }
  }

  throw new Error(
    "❌ YouTube is unreachable right now — all cookie-free providers (Cobalt, Invidious, Piped) failed for this video.\n\n" +
      "This is usually temporary (all public instances rate-limited at once) or the video is age-restricted/private and hidden from anonymous APIs.\n\n" +
      "Try again in a few minutes, or try a different public video. " +
      "For maximum reliability, self-host a Cobalt instance (ghcr.io/imputnet/cobalt) and set COBALT_API_URL."
  );
}
