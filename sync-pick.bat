@echo off
chcp 65001 >nul
title KanBarcode - ตั้งค่าตัวดึงข้อมูล (เลือก View เอง)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ผิดพลาด] ยังไม่ได้ติดตั้ง Node.js บนเครื่องนี้
  echo           ดาวน์โหลดที่ https://nodejs.org  ^(เลือกรุ่น LTS^) แล้วเปิดไฟล์นี้ใหม่
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\mssql" (
  echo กำลังติดตั้งไลบรารีครั้งแรก... รอสักครู่
  call npm install
  echo.
)

node sync-sql.js --pick
echo.
pause
