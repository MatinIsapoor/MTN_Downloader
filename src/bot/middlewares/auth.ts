import { Context } from "telegraf";
import { isAdmin } from "../../config";
import { upsertUser, isBanned } from "../../database";

export async function userMiddleware(ctx: Context, next: () => Promise<void>): Promise<void> {
  if (ctx.from) {
    const user = upsertUser({
      telegram_id: ctx.from.id,
      username: ctx.from.username ?? null,
      first_name: ctx.from.first_name ?? null,
      last_name: ctx.from.last_name ?? null,
    });

    if (user.is_banned) {
      // Allow admins to still use bot even if flagged? No, banned = blocked completely except unban
      // But admins should never be auto-banned; still check
      if (!isAdmin(ctx.from.id)) {
        await ctx.reply("🚫 You have been banned from using this bot.");
        return;
      }
    }
  }
  await next();
}

export function adminOnly(ctx: Context): boolean {
  const id = ctx.from?.id;
  if (!id || !isAdmin(id)) {
    ctx.reply("⛔ This command is for admins only.").catch(() => {});
    return false;
  }
  return true;
}
