# Telegram Video Downloader Bot

A Telegram bot that downloads videos from TikTok, YouTube, X/Twitter, and Instagram using fast direct-download APIs first with yt-dlp as fallback.

## Features

- **Multi-platform support**: TikTok, YouTube (including Shorts), X/Twitter, Instagram (Reels/Posts/Stories)
- **Admin panel**: Manage users, view stats, send broadcast messages
- **User stats**: Track download counts per user
- **SQLite database**: Persistent storage for user data and download history
- **Auto-cleanup**: Temporary files are automatically deleted
- **Fast download pipeline**: YouTube resolves via Invidious (direct progressive MP4, no cookies/merge) and any platform can use a self-hosted Cobalt API — yt-dlp is the automatic fallback, so downloads are faster and survive YouTube bot-checks that would block yt-dlp alone

## Prerequisites

1. **Node.js** 18+ and npm
2. **yt-dlp** installed and available in PATH (or specify custom path in .env)
   - Install: https://github.com/yt-dlp/yt-dlp#installation
   - Windows: `winget install yt-dlp`
   - macOS: `brew install yt-dlp`
   - Linux: `pip install yt-dlp`

3. **FFmpeg** (optional but recommended for merging video/audio)
   - Install: https://ffmpeg.org/download.html

## Setup

1. Clone/create the project and install dependencies:
```bash
cd telegram
npm install
```

2. Copy `.env.example` to `.env` and configure:
```bash
cp .env.example .env
```

3. Edit `.env`:
```env
# Required: Your Telegram bot token from @BotFather
BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11

# Required: Your Telegram user ID (get from @userinfobot)
ADMIN_IDS=123456789

# Optional
YT_DLP_PATH=yt-dlp
MAX_FILE_SIZE_MB=50
DOWNLOAD_DIR=./downloads
DATABASE_PATH=./data/bot.db
```

4. Build and run:
```bash
npm run build
npm start
```

Or for development:
```bash
npm run dev
```

## Bot Commands

### User Commands
| Command | Description |
|---------|-------------|
| `/start` | Welcome message with quick buttons |
| `/help` | Detailed usage instructions |
| `/stats` | Your download statistics |
| `/history` | Your recent downloads |

### Admin Commands
| Command | Description |
|---------|-------------|
| `/admin` | Open admin panel with inline buttons |

**Admin Panel Features:**
- **📊 Overall Stats**: Total users, downloads, platform breakdown, 7-day history
- **👥 User List**: Browse registered users
- **🔍 Find User**: Search by username, name, or ID
- **📈 Top Users**: Leaderboard of most active downloaders
- **📢 Broadcast**: Send message to all users

## Usage

1. Start the bot with `/start`
2. Send any supported video link:
   - `https://www.tiktok.com/@user/video/123456`
   - `https://youtube.com/shorts/abc123`
   - `https://x.com/user/status/123456`
   - `https://www.instagram.com/reel/abc123/`
3. Wait for the download to complete
4. Receive the video file

## Project Structure

```
telegram/
├── src/
│   ├── config/
│   │   └── index.ts          # Environment config & admin check
│   ├── database/
│   │   └── index.ts          # SQLite queries & helpers
│   ├── services/
│   │   ├── downloader.ts     # yt-dlp wrapper + fast-path orchestration
│   │   ├── invidious.ts      # YouTube fast path (direct MP4, no yt-dlp)
│   │   └── cobalt.ts         # optional self-hosted Cobalt API (all platforms)
│   ├── bot/
│   │   ├── middlewares/
│   │   │   └── auth.ts       # User tracking & admin check
│   │   └── handlers/
│   │       ├── user.ts       # User-facing commands
│   │       └── admin.ts      # Admin panel logic
│   ├── utils/
│   │   └── platform.ts       # URL detection & helpers
│   └── index.ts              # Entry point
├── .env.example
├── package.json
└── tsconfig.json
```

## Database Schema

**users**
- `id`: Internal ID
- `telegram_id`: Telegram user ID (unique)
- `username`, `first_name`, `last_name`: User info
- `is_banned`: Ban status (0/1)
- `download_count`: Successful downloads
- `created_at`, `last_seen`: Timestamps

**downloads**
- `id`: Download ID
- `user_id`: References users.id
- `telegram_id`: For quick lookups
- `url`: Original URL
- `platform`: Detected platform
- `status`: success/failed
- `file_size`: Size in bytes
- `created_at`: Timestamp

## Troubleshooting

**"yt-dlp not found"**
- Install yt-dlp: https://github.com/yt-dlp/yt-dlp#installation
- Or set `YT_DLP_PATH` in .env to full path

**YouTube: "Sign in to confirm you're not a bot" / do I need cookies?**
- Usually NO extra setup now. YouTube downloads try a fast non-yt-dlp path FIRST: a public Invidious instance resolves the direct MP4 (`INVIDIOUS_ENABLED=true` by default) — the instance's IP talks to YouTube, not your server's, so datacenter bot-checks don't apply, and there's no JS challenge, no cookies, and no slow DASH merge. yt-dlp (anonymous clients, then cookies) is the automatic fallback.
- Cookies are only a fallback for age-gated, private/members-only, or IP-rate-limited videos.
- Honest limit: Render uses datacenter IPs, which get YouTube's strictest
  bot-checks. No flag fixes a hard IP block 100% — if EVERY video fails,
  first redeploy (the build installs a fresh yt-dlp nightly; a build older
  than ~2 weeks fails on its own as YouTube changes its player — check the
  `yt-dlp version:` line in the Render logs), then wait ~1 hour (rate-limit),
  and if it persists the IP is flagged: set `YT_DLP_PROXY` to a
  residential proxy (the only real fix for a flagged IP).
- When cookies ARE needed (login-gated video), refreshing is normal
  maintenance (sessions expire every few weeks) and needs no restart:
  1. On your PC, open a FRESH private window, go to `youtube.com` and log in
     (use a throwaway Google account — downloader sessions get flagged).
  2. Install the **"Get cookies.txt LOCALLY"** extension and export cookies for YouTube,
     then close the private window immediately (don't keep browsing or log out —
     both rotate/invalidate the session).
  3. Send the `cookies.txt` file to the bot in Telegram as admin — it is validated
     and applied instantly (check with `/cookies`). No restart needed.
  4. On Render (ephemeral filesystem wipes uploaded files on restart/redeploy):
     also paste the file content into the `COOKIES_CONTENT` env var in the Render
     dashboard (raw text or base64). The bot restores `cookies.txt` from it on every boot.
  5. Run `/cookies` anytime to see status (expired count, missing login session, 7-day expiry warning).
  6. `YOUTUBE_COOKIE_MODE`: `auto` (default, anonymous first) / `cookies` (cookies first)
     / `never` (never use cookies).
- Alternative (local PC only): set `COOKIES_FROM_BROWSER=chrome` (or `firefox`/`edge`)
  in `.env` so yt-dlp reads cookies straight from your browser.

**Slow YouTube downloads?**
- YouTube normally skips yt-dlp entirely now: the Invidious fast path downloads a single muxed MP4 (no ffmpeg video+audio merge, the slowest step on small hosts), capped at 720p (`YOUTUBE_MAX_HEIGHT=720`, set `1080`/`0` for full quality) — 720p is 3-5x smaller, so it downloads and uploads to Telegram much faster and stays under the 50MB bot limit.
- The yt-dlp fallback path also uses 10MB HTTP chunks (throttle bypass), 8 parallel fragments, fast
  failover between player clients, and aria2c with 8 connections when installed
  (`build.sh` tries to install it; startup logs confirm).
- For ALL platforms at maximum speed, self-host a Cobalt instance (Docker: `ghcr.io/imputnet/cobalt`, ~$2–5/mo on Railway) and set `COBALT_API_URL` — it's tried first and returns direct MP4s. (Public cobalt.tools is blocked for YouTube since 2025, so self-host only.)

**TikTok: "blocked" / "Unexpected response from webpage"**
- TikTok aggressively blocks server IPs and changes its API. The bot now:
  1. retries yt-dlp with browser impersonation, then
  2. automatically falls back to resolving the mp4 via independent third-party
     providers (tikwm on two hosts, then ssstik) — if one is unreachable from
     your network, the next is tried (disable with `TIKTOK_FALLBACK=false`).
- If it still fails, the video is likely private/deleted, or TikTok is blocking
  the server's network — try again later or try another link.
- Keep `yt-dlp` up to date (`yt-dlp -U`), TikTok breakages are often fixed upstream
  within days.

**"Unsupported URL"**
- Ensure the video is public
- Check the URL is correct

**"Video too large"**
- Increase `MAX_FILE_SIZE_MB` in .env
- Or use shorter videos

**Download hangs**
- Some platforms have rate limits
- Try again after a few minutes

## License

MIT
