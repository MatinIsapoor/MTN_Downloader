export type Platform = "tiktok" | "youtube" | "twitter" | "instagram" | "unknown";

export function detectPlatform(url: string): Platform {
  const u = url.toLowerCase();
  if (u.includes("tiktok.com") || u.includes("vm.tiktok") || u.includes("vt.tiktok")) return "tiktok";
  if (u.includes("youtube.com") || u.includes("youtu.be") || u.includes("youtube-nocookie")) return "youtube";
  if (u.includes("twitter.com") || u.includes("x.com") || u.includes("t.co")) return "twitter";
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
    default: return "🎬";
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
