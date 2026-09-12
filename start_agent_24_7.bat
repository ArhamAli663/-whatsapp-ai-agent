@echo off
title WhatsApp AI Agent - 24/7 Lifetime Runner
color 0A

echo ========================================================
echo   WHATSAPP 24/7 MULTIMODAL AI AGENT (AUTO-RESTART LOOP)
echo   Target: +923298024266
echo   Web Dashboard: http://localhost:3000
echo ========================================================
echo.

:loop
echo [%date% %time%] Starting WhatsApp AI Agent...
node src/server.js
echo.
echo [%date% %time%] Agent stopped or crashed! Auto-restarting in 3 seconds...
timeout /t 3 /nobreak >nul
goto loop
