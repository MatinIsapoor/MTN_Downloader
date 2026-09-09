import { config } from "../config";
import { downloadViaCobalt, isCobaltConfigured } from "./cobalt";
import { downloadYouTubeViaInvidious } from "./invidious";
import { downloadYouTubeViaPiped, getLastPipedSummary } from "./piped";
import { downloadYouTubeViaAndroid } from "./android";
import { downloadYouTubeViaYtDlp, getLastYtDlpSummary, ytDlpFallbackStatus } from "./youtubeYtdlp";
import type { DownloadProgress, DownloadResult } from "./downloader";

/**
 * YouTube download pipeline (yt-dlp primary).
 *
 * Order (independent methods — each is another chance at the per-video wall):
 *   1. yt-dlp (primary ENGINE: per-client rotation, JS challenges, signature
 *      deciphering, cookies, impersonation, proxy) — first by default
 *      (YOUTUBE_YTDLP_FIRST=false restores cookie-free-first order)
 *   2. Cobalt API (only when self-hosted COBALT_API_URL is configured)
 *   3. Piped API (public path — verified working backends first, plus live
 *      discovery from the official instance list so it self-heals)
 *   4. Invidious (legacy fallback — most public instances disabled their API)
 *   5. youtubei multi-client (last plain-HTTPS resort — ANDROID → IOS →
 *      MWEB → WEB → TV rotations from our own IP, zero third parties)
 *
 * Piped/Invidious run on THEIR OWN server IPs (our datacenter IP's bot-wall
 * doesn't apply to them); youtubei + yt-dlp use OUR IP but with different
 * techniques/clients. YouTube walls per (video, IP[, client]), so each
 * route is another chance. Throws a user-facing error (❌…) when all fail.
 */
export async function downloadYouTubeCookieFree(
  url: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult> {
  let ytdlpWalled = false;

  // --- 1) yt-dlp FIRST (primary method, when enabled) -----------------------
  if (config.youtubeYtdlpFirst) {
    const first = await tryYtDlp(url, onProgress);
    if (first.result) return first.result;
    ytdlpWalled = first.walled;
  }

  // --- 2) Cobalt (self-hosted, fastest when available) -------------------
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

  // --- 3) Piped (public path) ---------------------------------------------
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

  // --- 4) Invidious (legacy fallback) -------------------------------------
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

  // --- 5) youtubei multi-client (last plain-HTTPS resort, our own IP) ------
  // Tracks whether OUR OWN IP was also walled, for the final error message.
  let androidWalled = false;
  try {
    console.log("⚡ YouTube: trying youtubei clients…");
    const fast = await downloadYouTubeViaAndroid(url, onProgress);
    if (fast) return fast;
  } catch (err: any) {
    if (err?.message?.startsWith("❌")) throw err;
    const msg = err?.message || String(err);
    console.warn(`⚠️ YouTube youtubei clients failed: ${msg.slice(0, 150)}`);
    if (/LOGIN_REQUIRED|not a bot|confirm you/i.test(msg)) androidWalled = true;
  }

  // --- yt-dlp LAST (only when not already tried first) ----------------------
  if (!config.youtubeYtdlpFirst) {
    const last = await tryYtDlp(url, onProgress);
    if (last.result) return last.result;
    ytdlpWalled = last.walled;
  }

  throw buildYouTubeError(androidWalled, ytdlpWalled);
}

/**
 * One yt-dlp pass over YouTube (per-client rotation inside). Returns the
 * file on success; otherwise { result: null, walled } so the caller can
 * continue with the next pipeline method. Re-throws definitive ❌ errors.
 */
async function tryYtDlp(
  url: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<{ result: DownloadResult | null; walled: boolean }> {
  if (!config.youtubeYtdlpFallback) return { result: null, walled: false };
  try {
    console.log("⚡ YouTube: trying yt-dlp…");
    const fast = await downloadYouTubeViaYtDlp(url, onProgress);
    if (fast) return { result: fast, walled: false };
    return { result: null, walled: getLastYtDlpSummary().walled > 0 };
  } catch (err: any) {
    if (err?.message?.startsWith("❌")) throw err;
    const msg = err?.message || String(err);
    console.warn(`⚠️ YouTube yt-dlp failed: ${msg.slice(0, 150)}`);
    const walled = /not a bot|LOGIN_REQUIRED|confirm you|player response|use --cookies/i.test(msg)
      || getLastYtDlpSummary().walled > 0;
    return { result: null, walled };
  }
}

/**
 * Failure-aware final error: tells video-gated apart from infra-blocked
 * using Piped's classified failure counts, so the user gets actionable
 * advice instead of a generic "unreachable".
 */
function buildYouTubeError(androidWalled = false, ytdlpWalled = false): Error {
  const s = getLastPipedSummary();
  // Extra admin hint when the final fallback couldn't even run — otherwise
  // the message looks identical to the pre-fallback era and hides the fix.
  const ytdlpStatus = ytDlpFallbackStatus();
  const ytdlpHint =
    ytdlpStatus === "disabled"
      ? "\n\n⚠️ Note for admin: the yt-dlp fallback is DISABLED (YOUTUBE_YTDLP_FALLBACK=false) — enable it for one more independent route."
      : ytdlpStatus === "missing"
        ? "\n\n⚠️ Note for admin: the yt-dlp fallback couldn't RUN here (no working yt-dlp binary — set YT_DLP_PATH, see server logs) — fix that for one more independent route."
        : "";
  // Backends agreed the video itself is gone — say so plainly.
  if (s.notFound > 0 && s.botWalled === 0 && !androidWalled && !ytdlpWalled) {
    return new Error(
      "❌ YouTube: this video looks private, deleted, or age-restricted — " +
        "the public servers can't see it, so there's nothing to download.\n\n" +
        "Try a different public video."
    );
  }
  // Everything (public backends AND our own server IP) got bot-walled.
  const walled = s.botWalled + (androidWalled ? 1 : 0) + (ytdlpWalled ? 1 : 0);
  if (walled > 0) {
    const routes: string[] = [];
    if (s.botWalled > 0) routes.push(`${s.botWalled} of ${s.tried} public server(s)`);
    if (androidWalled || ytdlpWalled) routes.push("this bot's own server");
    const where = routes.length > 0 ? `on ${routes.join(" and ")}` : "right now";
    return new Error(
      `❌ YouTube bot-blocked this video ${where} right now (its anti-bot wall is per-video and temporary).\n\n` +
        "Please try again in a few minutes — a different server usually answers on retry — " +
        "or try a different public video.\n\n" +
        "🔧 Admin: for reliable downloads, self-host Cobalt (ghcr.io/imputnet/cobalt) and set COBALT_API_URL." +
        ytdlpHint
    );
  }
  return new Error(
    "❌ YouTube download failed on every method (yt-dlp, Cobalt, Piped, Invidious, youtubei).\n\n" +
      "Please try again in a few minutes or try a different public video — " +
      "age-restricted/private videos are hidden from anonymous services and can't be downloaded.\n\n" +
      "🔧 Admin: check the Render logs for the per-method errors " +
      "(`⚠️ Piped … failed` / `⚠️ YouTube yt-dlp … failed`), or self-host Cobalt (ghcr.io/imputnet/cobalt) and set COBALT_API_URL for max reliability." +
      ytdlpHint
  );
}
