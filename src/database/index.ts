import initSqlJs, { Database as SqlJsDatabase } from "sql.js";
import * as fs from "fs";
import * as path from "path";
import { config } from "../config";

export interface User {
  id: number;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  is_banned: number;
  download_count: number;
  created_at: string;
  last_seen: string;
}

export interface Download {
  id: number;
  user_id: number;
  telegram_id: number;
  url: string;
  platform: string | null;
  status: string;
  file_size: number | null;
  created_at: string;
}

export interface StatRow {
  platform: string;
  count: number;
}

let db: SqlJsDatabase;

function persist(): void {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(config.databasePath, buffer);
}

export function getDb(): SqlJsDatabase {
  if (!db) throw new Error("Database not initialized. Call initDatabase() first.");
  return db;
}

export async function initDatabase(): Promise<SqlJsDatabase> {
  const dir = path.dirname(config.databasePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const SQL = await initSqlJs();

  if (fs.existsSync(config.databasePath)) {
    const fileBuffer = fs.readFileSync(config.databasePath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      is_banned INTEGER DEFAULT 0,
      download_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      telegram_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      platform TEXT,
      status TEXT NOT NULL DEFAULT 'success',
      file_size INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run("CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_downloads_telegram_id ON downloads(telegram_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_downloads_created_at ON downloads(created_at)");
  db.run("CREATE INDEX IF NOT EXISTS idx_downloads_platform ON downloads(platform)");

  persist();
  return db;
}

// ── Helpers ──

function queryAll(sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(sql: string, params: any[] = []): any | undefined {
  const rows = queryAll(sql, params);
  return rows[0];
}

function runSql(sql: string, params: any[] = []): void {
  db.run(sql, params);
  persist();
}

// ── User helpers ──

export function upsertUser(data: {
  telegram_id: number;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}): User {
  const now = new Date().toISOString();
  const existing = queryOne("SELECT * FROM users WHERE telegram_id = ?", [data.telegram_id]) as User | undefined;

  if (existing) {
    runSql(
      "UPDATE users SET username = ?, first_name = ?, last_name = ?, last_seen = ? WHERE telegram_id = ?",
      [data.username ?? existing.username, data.first_name ?? existing.first_name, data.last_name ?? existing.last_name, now, data.telegram_id]
    );
    return queryOne("SELECT * FROM users WHERE telegram_id = ?", [data.telegram_id]) as User;
  }

  runSql(
    "INSERT INTO users (telegram_id, username, first_name, last_name, last_seen) VALUES (?, ?, ?, ?, ?)",
    [data.telegram_id, data.username ?? null, data.first_name ?? null, data.last_name ?? null, now]
  );
  return queryOne("SELECT * FROM users WHERE telegram_id = ?", [data.telegram_id]) as User;
}

export function getUserByTelegramId(telegramId: number): User | undefined {
  return queryOne("SELECT * FROM users WHERE telegram_id = ?", [telegramId]) as User | undefined;
}

export function getAllUsers(limit = 100, offset = 0): User[] {
  return queryAll("SELECT * FROM users ORDER BY last_seen DESC LIMIT ? OFFSET ?", [limit, offset]) as User[];
}

export function getUserCount(): number {
  const r = queryOne("SELECT COUNT(*) as c FROM users") as { c: number };
  return r?.c ?? 0;
}

export function getBannedCount(): number {
  const r = queryOne("SELECT COUNT(*) as c FROM users WHERE is_banned = 1") as { c: number };
  return r?.c ?? 0;
}

export function banUser(telegramId: number): void {
  runSql("UPDATE users SET is_banned = 1 WHERE telegram_id = ?", [telegramId]);
}

export function unbanUser(telegramId: number): void {
  runSql("UPDATE users SET is_banned = 0 WHERE telegram_id = ?", [telegramId]);
}

export function isBanned(telegramId: number): boolean {
  const u = getUserByTelegramId(telegramId);
  return !!u?.is_banned;
}

export function searchUsers(query: string): User[] {
  const q = `%${query}%`;
  return queryAll(
    "SELECT * FROM users WHERE CAST(telegram_id AS TEXT) LIKE ? OR username LIKE ? OR first_name LIKE ? LIMIT 20",
    [q, q, q]
  ) as User[];
}

// ── Download helpers ──

export function recordDownload(data: {
  telegram_id: number;
  url: string;
  platform?: string | null;
  status?: string;
  file_size?: number | null;
}): void {
  const user = getUserByTelegramId(data.telegram_id);
  const userId = user?.id ?? upsertUser({ telegram_id: data.telegram_id }).id;

  runSql(
    "INSERT INTO downloads (user_id, telegram_id, url, platform, status, file_size) VALUES (?, ?, ?, ?, ?, ?)",
    [userId, data.telegram_id, data.url, data.platform ?? null, data.status ?? "success", data.file_size ?? null]
  );

  if ((data.status ?? "success") === "success") {
    runSql("UPDATE users SET download_count = download_count + 1 WHERE id = ?", [userId]);
  }
}

export function getDownloadsByUser(telegramId: number, limit = 10): Download[] {
  return queryAll(
    "SELECT * FROM downloads WHERE telegram_id = ? ORDER BY created_at DESC LIMIT ?",
    [telegramId, limit]
  ) as Download[];
}

export function getTotalDownloads(): number {
  const r = queryOne("SELECT COUNT(*) as c FROM downloads WHERE status = 'success'") as { c: number };
  return r?.c ?? 0;
}

export function getDownloadsToday(): number {
  const r = queryOne(
    "SELECT COUNT(*) as c FROM downloads WHERE status='success' AND date(created_at)=date('now')"
  ) as { c: number };
  return r?.c ?? 0;
}

export function getDownloadsLast7Days(): { date: string; count: number }[] {
  return queryAll(
    `SELECT date(created_at) as date, COUNT(*) as count FROM downloads WHERE status='success' AND created_at >= datetime('now','-7 days') GROUP BY date(created_at) ORDER BY date`
  ) as { date: string; count: number }[];
}

export function getPlatformStats(): StatRow[] {
  return queryAll(
    `SELECT platform, COUNT(*) as count FROM downloads WHERE status='success' GROUP BY platform ORDER BY count DESC`
  ) as StatRow[];
}

export function getTopUsers(limit = 10): User[] {
  return queryAll(
    `SELECT u.*, COUNT(d.id) as real_count FROM users u LEFT JOIN downloads d ON d.telegram_id = u.telegram_id AND d.status='success' GROUP BY u.id ORDER BY real_count DESC LIMIT ?`,
    [limit]
  ) as User[];
}

export function getOverallStats(): {
  totalUsers: number;
  bannedUsers: number;
  totalDownloads: number;
  todayDownloads: number;
  platformStats: StatRow[];
  topUsers: User[];
  last7Days: { date: string; count: number }[];
} {
  return {
    totalUsers: getUserCount(),
    bannedUsers: getBannedCount(),
    totalDownloads: getTotalDownloads(),
    todayDownloads: getDownloadsToday(),
    platformStats: getPlatformStats(),
    topUsers: getTopUsers(10),
    last7Days: getDownloadsLast7Days(),
  };
}
