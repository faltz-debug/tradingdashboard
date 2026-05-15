@echo off
title MT5 VPS Push
echo ============================================
echo   MT5 Push para VPS (194.34.232.12)
echo   Dashboard: http://194.34.232.12/vip.html
echo ============================================
echo.
echo IMPORTANTE: NAO abra o start.bat ao mesmo tempo
echo (causaria mensagens duplicadas no Telegram)
echo.
echo A iniciar mt5_feed_sync.py e mt5_push.py...
echo.

cd /d "%~dp0"

start "MT5 Feed Sync" cmd /k "python mt5_feed_sync.py"
timeout /t 3 /nobreak > nul
start "MT5 VPS Push" cmd /k "python deploy\mt5_push.py"

echo.
echo Ambos os scripts iniciados em janelas separadas.
echo Mantenha estas janelas abertas enquanto usar o VPS.
echo.
pause
