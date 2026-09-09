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
 *   2. Piped API (primary public path — verified working backends first,
 *      plus live discovery from the official instance list so it self-heals)
 *   3. Invidious (legacy fallback — most public instances disabled their API)
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

  // --- 2) Piped (primary public path) -------------------------------------
  if (config.pipedEnabled) {
    try {
      console.log("⚡ YouTube: trying Piped…");
      const fast = await downloadYouTubeViaPiped(url, onProgress);
      if (fast) return fast;
      console.log("⚡ YouTube: Piped unavailable for this video, trying Invidious…");
    } catch (err: any) {
      if (err?.message?.startsWith("❌")) throw err;
      console.warn(`⚠️ YouTube Piped failed, trying Invidious: ${(err?.message || String(err)).slice(0, 150)}`);
    }
  }

  // --- 3) Invidious (legacy fallback) -------------------------------------
  if (config.invidiousEnabled) {
    try {
      console.log("⚡ YouTube: trying Invidious…");
      const fast = await downloadYouTubeViaInvidious(url, onProgress);
      if (fast) return fast;
    } catch (err: any) {
      if (err?.message?.startsWith("❌")) throw err;
      console.warn(`⚠️ YouTube Invidious failed: ${(err?.message || String(err)).slice(0, 150)}`);
    }
  }

  throw new Error(
    "❌ YouTube download failed on every server (Cobalt, Piped, Invidious).\n\n" +
      "Please try again in a few minutes or try a different public video — " +
      "age-restricted/private videos are hidden from anonymous services and can't be downloaded.\n\n" +
      "🔧 Admin: check the Render logs for the per-instance errors " +
      "(`⚠️ Piped … failed`), or self-host Cobalt (ghcr.io/imputnet/cobalt) and set COBALT_API_URL for max reliability."
  );
}
