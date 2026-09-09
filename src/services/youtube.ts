import { config } from "../config";
import { downloadViaCobalt, isCobaltConfigured } from "./cobalt";
import { downloadYouTubeViaInvidious } from "./invidious";
import { downloadYouTubeViaPiped, getLastPipedSummary } from "./piped";
import { downloadYouTubeViaAndroid } from "./android";
import type { DownloadProgress, DownloadResult } from "./downloader";

/**
 * Cookie-free YouTube download pipeline — NO yt-dlp, NO cookies.
 *
 * Order (all plain HTTPS, single progressive MP4, no ffmpeg merge):
 *   1. Cobalt API (only when self-hosted COBALT_API_URL is configured)
 *   2. Piped API (primary public path — verified working backends first,
 *      plus live discovery from the official instance list so it self-heals)
 *   3. Invidious (legacy fallback — most public instances disabled their API)
 *   4. Android direct (last resort — youtubei ANDROID player API from our own
 *      IP: a different lottery draw with the bot-wall, zero third parties)
 *
 * Piped/Invidious run on THEIR OWN server IPs (our datacenter IP's bot-wall
 * doesn't apply to them); Android direct uses OUR IP as one final independent
 * draw. YouTube walls per (video, IP), so each route is another chance.
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

  // --- 4) Android direct (last resort, our own IP, no third party) ----------
  // Tracks whether OUR OWN IP was also walled, for the final error message.
  let androidWalled = false;
  try {
    console.log("⚡ YouTube: trying Android direct…");
    const fast = await downloadYouTubeViaAndroid(url, onProgress);
    if (fast) return fast;
  } catch (err: any) {
    if (err?.message?.startsWith("❌")) throw err;
    const msg = err?.message || String(err);
    console.warn(`⚠️ YouTube Android direct failed: ${msg.slice(0, 150)}`);
    if (/LOGIN_REQUIRED|not a bot|confirm you/i.test(msg)) androidWalled = true;
  }

  throw buildYouTubeError(androidWalled);
}

/**
 * Failure-aware final error: tells video-gated apart from infra-blocked
 * using Piped's classified failure counts, so the user gets actionable
 * advice instead of a generic "unreachable".
 */
function buildYouTubeError(androidWalled = false): Error {
  const s = getLastPipedSummary();
  // Backends agreed the video itself is gone — say so plainly.
  if (s.notFound > 0 && s.botWalled === 0 && !androidWalled) {
    return new Error(
      "❌ YouTube: this video looks private, deleted, or age-restricted — " +
        "the public servers can't see it, so there's nothing to download.\n\n" +
        "Try a different public video."
    );
  }
  // Everything (public backends AND our own server IP) got bot-walled.
  const walled = s.botWalled + (androidWalled ? 1 : 0);
  if (walled > 0) {
    const where =
      androidWalled && s.botWalled > 0
        ? `on ${s.botWalled} of ${s.tried} public server(s) and on this bot's own server`
        : androidWalled
          ? "even on this bot's own server"
          : `on ${s.botWalled} of ${s.tried} public server(s)`;
    return new Error(
      `❌ YouTube bot-blocked this video ${where} right now (its anti-bot wall is per-video and temporary).\n\n` +
        "Please try again in a few minutes — a different server usually answers on retry — " +
        "or try a different public video.\n\n" +
        "🔧 Admin: for reliable downloads, self-host Cobalt (ghcr.io/imputnet/cobalt) and set COBALT_API_URL."
    );
  }
  return new Error(
    "❌ YouTube download failed on every server (Cobalt, Piped, Invidious).\n\n" +
      "Please try again in a few minutes or try a different public video — " +
      "age-restricted/private videos are hidden from anonymous services and can't be downloaded.\n\n" +
      "🔧 Admin: check the Render logs for the per-instance errors " +
      "(`⚠️ Piped … failed`), or self-host Cobalt (ghcr.io/imputnet/cobalt) and set COBALT_API_URL for max reliability."
  );
}
