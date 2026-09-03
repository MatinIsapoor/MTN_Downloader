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

# نصب وابستگی‌های Node.js
echo "Installing Node.js dependencies..."
npm install

# ساخت پروژه
echo "Building project..."
npm run build

echo "Build completed successfully!"