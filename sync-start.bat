@echo off
chcp 65001 >nul
title KanBarcode - ตัวดึงข้อมูลอัตโนมัติ SQL Server -> Supabase
cd /d "%~dp0"

echo ============================================================
echo   KanBarcode - ตัวดึงข้อมูลอัตโนมัติจาก SQL Server
echo ============================================================
echo.

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

if not exist "sync-config.json" (
  echo [ผิดพลาด] ยังไม่มีไฟล์ sync-config.json
  echo           คัดลอก sync-config.example.json เป็น sync-config.json แล้วใส่ค่าจริงก่อน
  echo.
  pause
  exit /b 1
)

node sync-sql.js
echo.
echo ตัวดึงข้อมูลหยุดทำงานแล้ว
pause
