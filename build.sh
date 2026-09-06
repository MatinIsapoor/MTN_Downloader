#!/bin/bash

# به‌روزرسانی pip
echo "Updating pip..."
pip install --upgrade pip

# نصب نسخه Nightly یت‌دی‌ال‌پی
echo "Installing yt-dlp nightly..."
pip install -U --pre "yt-dlp[default]"

# نمایش نسخه نصب شده برای اطمینان
echo "yt-dlp version:"
yt-dlp --version

# Optional speed boost: aria2c (8-connection downloads). Best-effort only —
# never fails the build if the package manager is unavailable.
echo "Trying to install aria2c (optional, speeds up mp4 downloads)..."
(aria2c --version || apt-get install -y aria2 || sudo apt-get install -y aria2) 2>/dev/null || echo "aria2c not available, continuing with native downloader"
aria2c --version 2>/dev/null || true

# Optional PO-token provider plugin (bgutil) for YouTube datacenter
# bot-checks. Only installed when POT_PROVIDER=1 (needs a sidecar server at
# POT_SERVER_URL at runtime). Best-effort only — never fails the build.
if [ "${POT_PROVIDER:-0}" = "1" ]; then
  echo "Installing bgutil POT provider plugin (optional)..."
  (pip install -U "bgutil-ytdlp-pot-provider" 2>/dev/null && echo "bgutil plugin installed") || echo "bgutil plugin not available, continuing without PO-token provider"
else
  echo "Skipping bgutil POT plugin (set POT_PROVIDER=1 to enable)"
fi

# نصب وابستگی‌های Node.js
echo "Installing Node.js dependencies..."
npm install

# ساخت پروژه
echo "Building project..."
npm run build

echo "Build completed successfully!"