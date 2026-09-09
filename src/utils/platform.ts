export type Platform = "tiktok" | "youtube" | "twitter" | "instagram" | "pinterest" | "unknown";

export function detectPlatform(url: string): Platform {
  // Hostname-based detection (avoids substring traps like "t.co" matching
  // "pinterest.com", since "pinterest.com" contains "t.co").
  try {
    const host = new URL(url.trim()).hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    if (host === "youtu.be" || host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) return "youtube";
    if (host.endsWith("tiktok.com") || host === "vm.tiktok.com" || host === "vt.tiktok.com") return "tiktok";
    if (host === "pin.it" || host.endsWith("pinterest.com")) return "pinterest";
    if (host === "x.com" || host.endsWith("twitter.com") || host === "t.co") return "twitter";
    if (host.endsWith("instagram.com") || host === "instagr.am") return "instagram";
  } catch {}
  // Fallback for malformed URLs: substring scan (pinterest before twitter —
  // "pinterest.com" contains "t.co").
  const u = url.toLowerCase();
  if (u.includes("youtube.com") || u.includes("youtu.be") || u.includes("youtube-nocookie")) return "youtube";
  if (u.includes("tiktok.com") || u.includes("vm.tiktok") || u.includes("vt.tiktok")) return "tiktok";
  if (u.includes("pinterest.com") || u.includes("pin.it")) return "pinterest";
  if (u.includes("twitter.com") || u.includes("x.com")) return "twitter";
  if (u.includes("instagram.com") || u.includes("instagr.am")) return "instagram";
  return "unknown";
}

export function extractUrls(text: string): string[] {
  const regex = /https?:\/\/[^\s]+/gi;
  const matches = text.match(regex) || [];
  // strip trailing punctuation ) ] , . ! ?
  return matches.map((m) => m.replace(/[)\].,!?]+$/, ""));
}

export function isSupportedUrl(url: string): boolean {
  return detectPlatform(url) !== "unknown";
}

export function platformEmoji(p: string | null): string {
  switch (p) {
    case "tiktok": return "🎵";
    case "youtube": return "▶️";
    case "twitter": return "🐦";
    case "instagram": return "📸";
    case "pinterest": return "📌";
    default: return "🎬";
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
