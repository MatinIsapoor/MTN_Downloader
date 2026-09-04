import type { IncomingMessage, ServerResponse } from "http";

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 min (Render sleeps after ~15 min idle)
const MIN_INTERVAL_MS = 60 * 1000; // never ping more often than 1 min

/** Paths answered with 200 so Render / UptimeRobot / Telegram checks get traffic. */
export function isHealthPath(url?: string | null): boolean {
  if (!url) return false;
  const path = url.split("?")[0].replace(/\/+$/, "") || "/";
  return path === "" || path === "/" || path === "/health" || path === "/healthz" || path === "/ping";
}

/**
 * Serve health checks on Telegraf's webhook HTTP server (passed as `cb` to
 * bot.launch). Returns true when the request was handled.
 */
export function handleHealthRequest(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isHealthPath(req.url)) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const body = `OK - uptime ${Math.floor(process.uptime())}s`;
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  if (req.method === "GET") res.end(body);
  else res.end();
  return true;
}

export interface KeepaliveConfig {
  enabled: boolean;
  publicUrl: string;
  intervalMs: number;
}

export function resolveKeepaliveConfig(): KeepaliveConfig {
  const publicUrl = (
    process.env.KEEPALIVE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    ""
  ).trim().replace(/\/+$/, "");
  const rawInterval =
    process.env.KEEPALIVE_INTERVAL_MS ||
    (process.env.KEEPALIVE_INTERVAL_MINUTES
      ? String(Number(process.env.KEEPALIVE_INTERVAL_MINUTES) * 60 * 1000)
      : "");
  let intervalMs = Number(rawInterval) || DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
    intervalMs = MIN_INTERVAL_MS;
  }
  const explicitlyDisabled = (process.env.KEEPALIVE_ENABLED || "").toLowerCase() === "false";
  return { enabled: !explicitlyDisabled && publicUrl.length > 0, publicUrl, intervalMs };
}

/**
 * Ping our own public /health URL on an interval. Each ping is inbound HTTP
 * traffic, which resets Render's ~15 min idle spin-down timer while we are awake.
 * NOTE: this cannot wake an already-sleeping service — pair it with a free
 * external pinger (UptimeRobot / cron-job.org every 5 min -> /health).
 */
export function startSelfPing(publicUrl: string, intervalMs: number = DEFAULT_INTERVAL_MS) {
  const target = `${publicUrl.replace(/\/+$/, "")}/health`;
  console.log(`⏰ Keep-alive self-ping enabled: GET ${target} every ${Math.round(intervalMs / 60000)} min`);

  const ping = async () => {
    try {
      const res = await fetch(target, { headers: { "Cache-Control": "no-store" } });
      console.log(`⏰ Keep-alive ping: ${res.status} ${target}`);
    } catch (err) {
      console.warn(`⏰ Keep-alive ping failed: ${(err as Error).message}`);
    }
  };

  // Small initial delay so webhook registration finishes first, then interval.
  const initialDelay = Math.min(30 * 1000, intervalMs);
  const initialTimer = setTimeout(() => {
    void ping();
  }, initialDelay);
  if (typeof initialTimer === "object" && "unref" in initialTimer) {
    (initialTimer as NodeJS.Timeout).unref?.();
  }

  const timer = setInterval(() => {
    void ping();
  }, intervalMs);
  if (typeof timer === "object" && "unref" in timer) {
    (timer as NodeJS.Timeout).unref?.();
  }
  return timer;
}
