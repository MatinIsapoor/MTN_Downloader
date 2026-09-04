import { Telegraf, Context } from "telegraf";
import { config, isAdmin } from "./config";
import { initDatabase } from "./database";
import { userMiddleware } from "./bot/middlewares/auth";
import { registerUserHandlers } from "./bot/handlers/user";
import {
  registerAdminHandlers,
  isBroadcastWaiting,
  handleAdminText,
  isFindWaiting,
  setFindWaiting,
  handleFindText,
} from "./bot/handlers/admin";
import { cleanupOldFiles, logDownloaderDiagnostics } from "./services/downloader";
import {
  handleHealthRequest,
  resolveKeepaliveConfig,
  startSelfPing,
} from "./services/keepalive";

async function main() {
  console.log("🚀 Starting Telegram Downloader Bot...");

  // Initialize database (async for sql.js)
  await initDatabase();
  console.log("✅ Database initialized");

  // Downloader health: yt-dlp version, cookies, JS runtime, fallbacks
  logDownloaderDiagnostics();

  // Create bot
  const bot = new Telegraf<Context>(config.botToken);

  // Global middleware
  bot.use(userMiddleware);

  // Register handlers
  registerUserHandlers(bot);
  registerAdminHandlers(bot);

  // Handle admin find-user trigger: intercept /find command
  bot.command("find", (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    setFindWaiting(ctx.from.id);
    ctx.reply("🔍 Send a username, name, or Telegram ID to search:");
  });

  // Handle admin broadcast trigger: intercept /broadcast command
  bot.command("broadcast", (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    // Import at top would be circular, so we access via action
    // This is handled by the admin_broadcast action, but we also allow the command
    ctx.reply("📢 Use the /admin panel and click *Broadcast* to send a message.", { parse_mode: "Markdown" });
  });

  // Intercept text messages for admin text input (broadcast, find)
  bot.on("text", async (ctx, next) => {
    const userId = ctx.from.id;
    const text = ctx.message.text;

    // Skip commands
    if (text.startsWith("/")) return next();

    // Check if admin is in find-user mode
    if (isAdmin(userId) && isFindWaiting(userId)) {
      const consumed = await handleFindText(ctx);
      if (consumed) return;
    }

    // Check if admin is in broadcast mode
    if (isAdmin(userId) && isBroadcastWaiting(userId)) {
      const consumed = await handleAdminText(ctx);
      if (consumed) return;
    }

    return next();
  });

  // Error handler
  bot.catch((err, ctx) => {
    console.error(`Error handling ${ctx.updateType}:`, err);
  });

  // Cleanup old downloads every hour
  setInterval(() => {
    cleanupOldFiles(2);
    console.log("🧹 Cleaned up old download files");
  }, 60 * 60 * 1000);

  // Start bot
    // Start bot with Webhook (for Render) or Polling (for local)
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const isRender = !!process.env.RENDER_EXTERNAL_URL;

  if (isRender) {
    // در Render: از Webhook استفاده کن (public launch API; startWebhook is private)
    const domain = process.env.RENDER_EXTERNAL_URL as string;
    await bot.launch({
      webhook: {
        domain,
        path: "/webhook",
        port: PORT,
        // Telegraf calls this `cb` for any non-webhook request, so use it to
        // answer Render / UptimeRobot health checks on the same PORT.
        cb: (req, res) => {
          if (handleHealthRequest(req, res)) return;
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
        },
      },
    });
    console.log(`✅ Webhook تنظیم شد: ${domain}/webhook`);
    console.log(`🚀 ربات روی پورت ${PORT} در حال اجراست!`);
    console.log(`🏓 Health check: ${domain}/health`);

    // Self-ping generates inbound traffic every ~10 min, resetting Render's
    // ~15 min idle spin-down timer while the instance is awake. It cannot wake
    // an already-sleeping instance, so also add a free external pinger
    // (UptimeRobot / cron-job.org every 5 min -> <domain>/health).
    const keepalive = resolveKeepaliveConfig();
    if (keepalive.enabled) {
      startSelfPing(keepalive.publicUrl, keepalive.intervalMs);
    } else {
      console.log("⏰ Keep-alive self-ping disabled (set KEEPALIVE_URL or RENDER_EXTERNAL_URL to enable)");
    }
  } else {
    // در محیط محلی (کامپیوتر خودتان): از Polling استفاده کن
    await bot.launch();
    console.log("✅ Bot is running locally with polling!");
  }

  // Graceful stop
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch((err) => {
  console.error("❌ Failed to start bot:", err);
  process.exit(1);
});
