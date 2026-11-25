@echo off
title LapakProperti Launcher

echo Menjalankan Backend Express...
start "Backend LapakProperti" cmd /k "cd /d C:\Users\ACER\lapakproperti-app\backend && node server.js"

echo Menjalankan Frontend Astro...
start "Frontend Astro" cmd /k "cd /d C:\Users\ACER\lapakproperti-app\frontend && npm run dev"