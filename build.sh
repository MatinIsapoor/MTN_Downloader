#!/bin/bash

# به‌روزرسانی pip
echo "Updating pip..."
pip install --upgrade pip

# نصب و به‌روزرسانی yt-dlp به آخرین نسخه
echo "Installing yt-dlp..."
pip install --upgrade yt-dlp

# نمایش نسخه‌ی نصب‌شده برای اطمینان
echo "yt-dlp version:"
yt-dlp --version

# نصب وابستگی‌های Node.js
echo "Installing Node.js dependencies..."
npm install

# ساخت پروژه
echo "Building project..."
npm run build

echo "Build completed successfully!"