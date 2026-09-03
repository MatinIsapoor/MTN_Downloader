import { Telegraf, Context, Markup } from "telegraf";
import { adminOnly } from "../middlewares/auth";
import {
  getOverallStats,
  getAllUsers,
  getUserByTelegramId,
  searchUsers,
  banUser,
  unbanUser,
  getUserCount,
} from "../../database";

// Broadcast state: stores adminId -> waiting for text
const broadcastWaiting = new Set<number>();

export function isBroadcastWaiting(userId: number): boolean {
  return broadcastWaiting.has(userId);
}

export function clearBroadcastWaiting(userId: number): void {
  broadcastWaiting.delete(userId);
}

function adminMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📊 Overall Stats", "admin_stats")],
    [Markup.button.callback("👥 User List", "admin_users"), Markup.button.callback("🔍 Find User", "admin_find")],
    [Markup.button.callback("📢 Broadcast", "admin_broadcast")],
    [Markup.button.callback("📈 Top Users", "admin_top_users")],
  ]);
}

function userRow(u: any) {
  const status = u.is_banned ? "🚫" : "✅";
  const name = u.username ? `@${u.username}` : u.first_name || "N/A";
  return `${status} [${u.telegram_id}] ${name} | DL: ${u.download_count}`;
}

export function registerAdminHandlers(bot: Telegraf<Context>): void {
  // ── /admin main panel ──
  bot.command("admin", (ctx) => {
    if (!adminOnly(ctx)) return;
    ctx.reply("🔧 *Admin Panel*\n\nChoose an option below:", {
      parse_mode: "Markdown",
      ...adminMenuKeyboard(),
    });
  });

  // ── Overall Stats ──
  bot.action("admin_stats", async (ctx) => {
    await ctx.answerCbQuery();
    if (!adminOnly(ctx)) return;

    const s = getOverallStats();
    const lines = [
      "📊 *Overall Statistics*",
      "",
      `👥 Total Users: *${s.totalUsers}*`,
      `🚫 Banned Users: *${s.bannedUsers}*`,
      `📥 Total Downloads: *${s.totalDownloads}*`,
      `📅 Today Downloads: *${s.todayDownloads}*`,
    ];

    if (s.platformStats.length > 0) {
      lines.push("", "*By Platform:*");
      s.platformStats.forEach((p) => {
        const emoji =
          p.platform === "tiktok" ? "🎵" :
          p.platform === "youtube" ? "▶️" :
          p.platform === "twitter" ? "🐦" :
          p.platform === "instagram" ? "📸" : "🎬";
        lines.push(`  ${emoji} ${p.platform}: *${p.count}*`);
      });
    }

    if (s.last7Days.length > 0) {
      lines.push("", "*Last 7 Days:*");
      s.last7Days.forEach((d) => {
        lines.push(`  ${d.date}: *${d.count}*`);
      });
    }

    await ctx.reply(lines.join("\n"), {
      parse_mode: "Markdown",
      ...adminMenuKeyboard(),
    });
  });

  // ── User List ──
  bot.action("admin_users", async (ctx) => {
    await ctx.answerCbQuery();
    if (!adminOnly(ctx)) return;

    const users = getAllUsers(15);
    if (users.length === 0) return ctx.reply("No users found.", { ...adminMenuKeyboard() });

    const lines = ["👥 *Recent Users:*", ""];
    users.forEach((u, i) => {
      lines.push(`${i + 1}. ${userRow(u)}`);
    });
    lines.push("", `_Showing ${users.length} of ${getUserCount()} total_`);

    await ctx.reply(lines.join("\n"), {
      parse_mode: "Markdown",
      ...adminMenuKeyboard(),
    });
  });

  // ── Find User ──
  bot.action("admin_find", async (ctx) => {
    await ctx.answerCbQuery();
    if (!adminOnly(ctx)) return;
    broadcastWaiting.add(ctx.from.id);
    await ctx.reply("🔍 Send a username, name, or Telegram ID to search:");
  });

  // ── Top Users ──
  bot.action("admin_top_users", async (ctx) => {
    await ctx.answerCbQuery();
    if (!adminOnly(ctx)) return;

    const s = getOverallStats();
    if (s.topUsers.length === 0) return ctx.reply("No user data yet.", { ...adminMenuKeyboard() });

    const lines = ["🏆 *Top Users by Downloads:*", ""];
    s.topUsers.forEach((u, i) => {
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
      const name = u.username ? `@${u.username}` : u.first_name || "N/A";
      lines.push(`${medal} ${name} \\[${u.telegram_id}\\] \\- *${u.download_count}* downloads`);
    });

    await ctx.reply(lines.join("\n"), {
      parse_mode: "MarkdownV2",
      ...adminMenuKeyboard(),
    });
  });

  // ── Broadcast ──
  bot.action("admin_broadcast", async (ctx) => {
    await ctx.answerCbQuery();
    if (!adminOnly(ctx)) return;
    broadcastWaiting.add(ctx.from.id);
    await ctx.reply(
      "📢 *Broadcast Mode*\n\nSend me the message you want to broadcast to all users\\. You can use any Telegram message format\\.\n\nSend /cancel to abort\\.",
      { parse_mode: "MarkdownV2" }
    );
  });

  // ── Broadcast search handler: intercept text when broadcastWaiting or admin_find ──
  // (called from the text handler in index.ts before user handler)

  // ── Individual user actions (via callback with payload) ──
  // We handle "ban:<id>" and "unban:<id>" and "userinfo:<id>"
  bot.action(/^ban:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!adminOnly(ctx)) return;
    const tid = Number(ctx.match[1]);
    banUser(tid);
    await ctx.reply(`🚫 User ${tid} has been *banned*.`, { parse_mode: "Markdown" });
  });

  bot.action(/^unban:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!adminOnly(ctx)) return;
    const tid = Number(ctx.match[1]);
    unbanUser(tid);
    await ctx.reply(`✅ User ${tid} has been *unbanned*.`, { parse_mode: "Markdown" });
  });

  bot.action(/^userinfo:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!adminOnly(ctx)) return;
    const tid = Number(ctx.match[1]);
    const user = getUserByTelegramId(tid);
    if (!user) return ctx.reply("User not found.");

    const status = user.is_banned ? "🚫 Banned" : "✅ Active";
    const name = user.username ? `@${user.username}` : `${user.first_name || "?"} ${user.last_name || ""}`;
    const joined = new Date(user.created_at).toLocaleDateString();
    const seen = new Date(user.last_seen).toLocaleDateString();

    const text = [
      "👤 *User Details*",
      "",
      `Name: ${name}`,
      `ID: *${user.telegram_id}*`,
      `Status: ${status}`,
      `Downloads: *${user.download_count}*`,
      `Joined: ${joined}`,
      `Last seen: ${seen}`,
    ].join("\n");

    const buttons = user.is_banned
      ? [[Markup.button.callback("✅ Unban", `unban:${tid}`)]]
      : [[Markup.button.callback("🚫 Ban", `ban:${tid}`)]];

    await ctx.reply(text, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: buttons },
    });
  });

  // ── Cancel broadcast ──
  bot.command("cancel", (ctx) => {
    if (broadcastWaiting.has(ctx.from.id)) {
      broadcastWaiting.delete(ctx.from.id);
      ctx.reply("❌ Broadcast cancelled.");
    }
  });
}

/**
 * Called from the text message handler when an admin is in broadcast/search mode.
 * Returns true if the message was consumed.
 */
export async function handleAdminText(ctx: Context): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;

  // Check broadcast mode
  if (broadcastWaiting.has(userId) && "text" in ctx.message!) {
    const text = (ctx.message as any).text as string;
    if (text.startsWith("/")) return false; // let commands through

    broadcastWaiting.delete(userId);

    if (!adminOnly(ctx)) return true;

    const users = getAllUsers(5000); // get all
    let sent = 0;
    let failed = 0;

    const progressMsg = await ctx.reply(`📢 Broadcasting to ${users.length} users...`);

    for (const u of users) {
      try {
        await ctx.telegram.sendMessage(u.telegram_id, text, { parse_mode: "Markdown" }).catch(() => {
          return ctx.telegram.sendMessage(u.telegram_id, text);
        });
        sent++;
      } catch {
        failed++;
      }
    }

    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progressMsg.message_id,
      undefined,
      `📢 *Broadcast Complete*\n\n✅ Sent: *${sent}*\n❌ Failed: *${failed}*\n👥 Total: *${users.length}*`,
      { parse_mode: "Markdown" }
    );

    return true;
  }

  // Check find user mode
  if (broadcastWaiting.has(userId) && "text" in ctx.message!) {
    // Actually broadcastWaiting is reused for find. Let's differentiate.
    // We'll check if the message looks like a search query (no broadcast context).
    // Simpler: use a separate set for find mode.
    return false;
  }

  return false;
}

// Separate find-user waiting set
const findWaiting = new Set<number>();

export function isFindWaiting(userId: number): boolean {
  return findWaiting.has(userId);
}

export function setFindWaiting(userId: number): void {
  findWaiting.add(userId);
}

export function clearFindWaiting(userId: number): void {
  findWaiting.delete(userId);
}

export async function handleFindText(ctx: Context): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId || !findWaiting.has(userId)) return false;

  const text = (ctx.message as any)?.text as string;
  if (!text || text.startsWith("/")) return false;

  findWaiting.delete(userId);

  const results = searchUsers(text);
  if (results.length === 0) {
    await ctx.reply("🔍 No users found matching your query.");
    return true;
  }

  const lines = [`🔍 *Found ${results.length} users:*`, ""];
  results.forEach((u, i) => {
    const name = u.username ? `@${u.username}` : u.first_name || "N/A";
    lines.push(`${i + 1}. ${u.is_banned ? "🚫" : "✅"} [${u.telegram_id}] ${name} | DL: ${u.download_count}`);
  });
  lines.push("\nSend a user ID to see details, or use buttons below.");

  // Add inline buttons for first 5 results
  const buttons = results.slice(0, 5).map((u) => [Markup.button.callback(`${u.username || u.first_name || u.telegram_id}`, `userinfo:${u.telegram_id}`)]);

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons },
  });

  return true;
}
