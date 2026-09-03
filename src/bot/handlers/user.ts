import { Telegraf, Context } from "telegraf";
import { message } from "telegraf/filters";
import { downloadVideo, cleanupFile } from "../../services/downloader";
import { extractUrls, isSupportedUrl, detectPlatform, platformEmoji, formatBytes } from "../../utils/platform";
import { recordDownload, getDownloadsByUser, getUserByTelegramId } from "../../database";
import { Input } from "telegraf";

const processing = new Set<number>(); // prevent concurrent downloads per user

export function registerUserHandlers(bot: Telegraf<Context>): void {
  bot.start(async (ctx) => {
    const name = ctx.from.first_name || "there";
    await ctx.reply(
      `👋 Hello ${name}!\n\n` +
        `Send me a link from:\n` +
        `🎵 TikTok\n` +
        `▶️ YouTube (including Shorts)\n` +
        `🐦 X / Twitter\n` +
        `📸 Instagram (Reels, Posts, Stories if public)\n\n` +
        `Just paste the URL and I'll download the video for you.\n\n` +
        `Commands:\n` +
        `/start - Show this message\n` +
        `/help - How to use\n` +
        `/stats - Your download stats\n` +
        `/history - Your recent downloads`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📊 My Stats", callback_data: "user_stats" }],
            [{ text: "ℹ️ Help", callback_data: "user_help" }],
          ],
        },
      }
    );
  });

  bot.help(async (ctx) => {
    await ctx.reply(
      `ℹ️ *How to use:*\n\n` +
        `1\\. Just send any supported video link\n` +
        `2\\. Wait a few seconds while I download it\n` +
        `3\\. Get the video file back in chat\n\n` +
        `*Supported platforms:*\n` +
        `• TikTok \\- \`tiktok\\.com\`\n` +
        `• YouTube \\- \`youtube\\.com\` / \`youtu\\.be\` \\(videos & shorts\\)\n` +
        `• X / Twitter \\- \`x\\.com\` / \`twitter\\.com\`\n` +
        `• Instagram \\- \`instagram\\.com\`\n\n` +
        `*Tips:*\n` +
        `• Make sure the video is public\n` +
        `• Only one download at a time per user\n` +
        `• Max file size: configured by admin \\(default 50MB\\)\n\n` +
        `If a download fails, try again or try a different link\\.`,
      { parse_mode: "MarkdownV2" }
    );
  });

  bot.command("stats", async (ctx) => {
    const user = getUserByTelegramId(ctx.from.id);
    const count = user?.download_count ?? 0;
    const downloads = getDownloadsByUser(ctx.from.id, 5);
    let text = `📊 *Your Stats*\n\nTotal downloads: *${count}*\n`;
    if (downloads.length > 0) {
      text += `\n*Recent:*\n`;
      downloads.forEach((d, i) => {
        text += `${i + 1}\\. ${platformEmoji(d.platform)} ${d.platform || "unknown"} \\- ${d.status} \\- ${escapeMd(d.url.slice(0, 40))}\n`;
      });
    }
    await ctx.reply(text, { parse_mode: "MarkdownV2" });
  });

  bot.command("history", async (ctx) => {
    const downloads = getDownloadsByUser(ctx.from.id, 10);
    if (downloads.length === 0) return ctx.reply("📭 No downloads yet. Send me a link to start!");
    const lines = downloads.map((d, i) => {
      const date = new Date(d.created_at).toLocaleDateString();
      return `${i + 1}. ${platformEmoji(d.platform)} ${d.platform || "?" } [${d.status}] ${date}\n   ${d.url.slice(0, 60)}`;
    });
    await ctx.reply(`📜 *Your last ${downloads.length} downloads:*\n\n` + lines.join("\n\n"));
  });

  bot.action("user_stats", async (ctx) => {
    await ctx.answerCbQuery();
    const user = getUserByTelegramId(ctx.from!.id);
    const count = user?.download_count ?? 0;
    await ctx.reply(`📊 You have made *${count}* successful downloads.`, { parse_mode: "Markdown" });
  });

  bot.action("user_help", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `ℹ️ Send me any TikTok, YouTube, X/Twitter or Instagram link and I'll download the video for you!`
    );
  });

  // Main handler – any text containing URLs
  bot.on(message("text"), async (ctx, next) => {
    const text = ctx.message.text;

    // Skip if it's a command
    if (text.startsWith("/")) return next();

    const urls = extractUrls(text);
    const supported = urls.filter(isSupportedUrl);

    if (urls.length === 0) return next(); // no URL, ignore
    if (supported.length === 0) {
      await ctx.reply(
        "❌ No supported links found.\n\nSupported: TikTok, YouTube, X/Twitter, Instagram.\nExample: https://www.tiktok.com/@user/video/123..."
      );
      return;
    }

    // Only process first supported URL to avoid spam
    const url = supported[0];
    if (supported.length > 1) {
      await ctx.reply(`🔗 Found ${supported.length} links, processing the first one:\n${url}`);
    }

    const userId = ctx.from.id;
    if (processing.has(userId)) {
      await ctx.reply("⏳ You already have a download in progress. Please wait...");
      return;
    }
    processing.add(userId);

    const platform = detectPlatform(url);
    let statusMsg: any;
    try {
      statusMsg = await ctx.reply(`${platformEmoji(platform)} Downloading from *${platform}*… Please wait…`, {
        parse_mode: "Markdown",
      });

      // Optional: edit message on progress (throttled)
      let lastEdit = 0;
      const result = await downloadVideo(url, (p) => {
        const now = Date.now();
        if (now - lastEdit < 2000) return;
        lastEdit = now;
        if (p.percent) {
          ctx.telegram
            .editMessageText(
              ctx.chat.id,
              statusMsg.message_id,
              undefined,
              `${platformEmoji(platform)} Downloading… ${p.percent.toFixed(1)}%`
            )
            .catch(() => {});
        }
      });

      // Check file size vs Telegram limit (50MB for bots via sendVideo, but 2000MB with local API)
      // We'll attempt to send; if too large, inform user
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        `✅ Downloaded! Uploading to Telegram… (${formatBytes(result.size)})`
      );

      const caption = `${platformEmoji(platform)} ${platform} video\n🔗 ${url}`;
      await ctx.replyWithVideo(Input.fromLocalFile(result.filePath, result.fileName), { caption });

      recordDownload({
        telegram_id: userId,
        url,
        platform,
        status: "success",
        file_size: result.size,
      });

      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      cleanupFile(result.filePath);
    } catch (err: any) {
      const msg = err?.message || "Unknown error";
      recordDownload({
        telegram_id: userId,
        url,
        platform,
        status: "failed",
      });
      try {
        if (statusMsg) {
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, msg);
        } else {
          await ctx.reply(msg);
        }
      } catch {
        await ctx.reply(msg).catch(() => {});
      }
    } finally {
      processing.delete(userId);
    }
  });
}

function escapeMd(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}
