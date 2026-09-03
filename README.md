# Telegram Video Downloader Bot

A Telegram bot that downloads videos from TikTok, YouTube, X/Twitter, and Instagram using yt-dlp.

## Features

- **Multi-platform support**: TikTok, YouTube (including Shorts), X/Twitter, Instagram (Reels/Posts/Stories)
- **Admin panel**: Manage users, view stats, send broadcast messages
- **User stats**: Track download counts per user
- **SQLite database**: Persistent storage for user data and download history
- **Auto-cleanup**: Temporary files are automatically deleted

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
│   │   └── downloader.ts     # yt-dlp wrapper
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

**YouTube: "Sign in to confirm you're not a bot"**
- YouTube requires a logged-in session for most videos when downloaded from a server.
  The bot retries several player clients automatically, but without cookies many
  videos will still fail. Fix (one-time setup):
  1. On your PC, open Chrome/Firefox, go to `youtube.com` and log in.
  2. Install the **"Get cookies.txt LOCALLY"** extension and export cookies for YouTube.
  3. Save the file as `cookies.txt` in the bot folder (same folder as `.env`),
     or set a custom path via `COOKIES_PATH` in `.env`. Never commit this file to git.
  4. Restart the bot — startup logs will confirm `Cookies: using file ...`.
  5. Refresh the cookies every few weeks (YouTube sessions expire).
- Alternative (local PC only): set `COOKIES_FROM_BROWSER=chrome` (or `firefox`/`edge`)
  in `.env` so yt-dlp reads cookies straight from your browser.

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
