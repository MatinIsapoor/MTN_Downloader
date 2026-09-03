#!/bin/bash

# نصب و به‌روزرسانی yt-dlp
echo "Installing yt-dlp..."
pip install --upgrade yt-dlp

# نصب وابستگی‌های Node.js
echo "Installing Node.js dependencies..."
npm install

# ساخت پروژه TypeScript
echo "Building project..."
npm run build

echo "Build completed successfully!"