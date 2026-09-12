@echo off
title Enable Auto-Start on Windows Boot
color 0A

set "TARGET_BAT=E:\AI agent\run_hidden_background.vbs"
set "SHORTCUT_PATH=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\WhatsApp_AI_Agent.lnk"

powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT_PATH%'); $s.TargetPath = 'wscript.exe'; $s.Arguments = '\"%TARGET_BAT%\"'; $s.WorkingDirectory = 'E:\AI agent'; $s.Save()"

echo ========================================================
echo   [SUCCESS] WhatsApp AI Agent Auto-Start Enabled!
echo   Whenever your PC or Laptop boots up or restarts,
echo   the bot will automatically run invisibly in the background.
echo ========================================================
pause
