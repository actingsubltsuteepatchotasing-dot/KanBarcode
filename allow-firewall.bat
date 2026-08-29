@echo off
chcp 65001 >nul
title KanBarcode - เปิดให้เครื่องอื่นในวงเข้าใช้งาน (พอร์ต 3000)

rem ---- ต้องใช้สิทธิ์ผู้ดูแลระบบ ถ้ายังไม่ได้ ขอ UAC แล้วเปิดตัวเองใหม่ ----
net session >nul 2>&1
if errorlevel 1 (
  echo ต้องใช้สิทธิ์ผู้ดูแลระบบ - กำลังขออนุญาต...
  echo ถ้ามีหน้าต่างเด้งถาม ให้กด  Yes / ใช่
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" >nul 2>&1
  exit /b
)

echo ============================================================
echo   เปิดพอร์ต 3000 ให้เครื่องอื่นในวงเข้าใช้งาน KanBarcode
echo ============================================================
echo.

rem ---- ลบกฎเดิมชื่อเดียวกันก่อน จะได้ไม่ซ้ำเวลารันหลายรอบ ----
netsh advfirewall firewall delete rule name="KanBarcode 3000" >nul 2>&1

netsh advfirewall firewall add rule name="KanBarcode 3000" dir=in action=allow protocol=TCP localport=3000 profile=any
if errorlevel 1 (
  echo.
  echo [ผิดพลาด] เพิ่มกฎไม่สำเร็จ
  echo.
  pause
  exit /b 1
)

echo.
echo เรียบร้อย - เครื่องอื่นในวงเปิดเว็บได้แล้ว
echo.
echo ไอพีของเครื่องนี้:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo    http://%%a:3000
echo.
echo (ลบกฎนี้ทีหลังได้ด้วยคำสั่ง
echo    netsh advfirewall firewall delete rule name="KanBarcode 3000"  )
echo.
pause
