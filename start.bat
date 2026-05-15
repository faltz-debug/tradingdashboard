@echo off
cd /d "%~dp0"
title Trading Dashboard VIP

echo.
echo ================================================
echo   Trading Dashboard VIP - Startup
echo ================================================
echo.

REM Verificar Node.js
node -v >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado! Baixe em: https://nodejs.org/
    pause
    exit /b 1
)
echo [OK] Node.js encontrado

REM Verificar Python
set PYTHON_OK=0
python --version >nul 2>&1
if not errorlevel 1 set PYTHON_OK=1
if "%PYTHON_OK%"=="1" (
    echo [OK] Python encontrado
) else (
    echo [AVISO] Python nao encontrado - MT5 sync e bot NAO serao iniciados
)

REM Matar node.exe anterior (liberar porta 3000)
taskkill /f /im node.exe >nul 2>&1
REM Matar processos Python antigos deste projeto (evita bot/bridge duplicados)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process | Where-Object { ($_.CommandLine -like '*mt5_feed_sync.py*') -or ($_.CommandLine -like '*bot_webhook_receiver.py*') } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }" >nul 2>&1
timeout /t 1 /nobreak >nul

REM Instalar dependencias se necessario
if not exist "node_modules" (
    echo [INFO] Instalando dependencias Node...
    call npm install
    if errorlevel 1 (
        echo [ERRO] Falha no npm install
        pause
        exit /b 1
    )
)

echo.
echo ================================================
echo  Iniciando servicos...
echo ================================================
echo.

REM [1/3] MT5 Feed Sync
if "%PYTHON_OK%"=="1" (
    echo [1/3] Iniciando MT5 Feed Sync...
    start "MT5 Feed Sync" cmd /k "cd /d "%~dp0" && python mt5_feed_sync.py"
    timeout /t 5 /nobreak >nul
) else (
    echo [1/3] MT5 Sync pulado
)

REM [2/3] Bot Webhook
if "%PYTHON_OK%"=="1" (
    echo [2/3] Iniciando Bot Webhook porta 5000...
    start "Bot Webhook MT5" cmd /k "cd /d "%~dp0" && python bot_webhook_receiver.py"
    timeout /t 5 /nobreak >nul
) else (
    echo [2/3] Bot Webhook pulado
)

REM [3/3] Servidor Node.js (esta janela)
echo [3/3] Iniciando servidor Node.js...
echo.
echo ================================================
echo  VIP Panel:   http://localhost:3000/vip.html
echo  Dashboard:   http://localhost:3000/dashboard.html
echo  Status MT5:  http://localhost:3000/api/mt5/bridge-status
echo  Bot Status:  http://localhost:5000/status
echo  Ctrl+C para parar
echo ================================================
echo.

node server.js
echo.
echo [INFO] Servidor encerrado.
pause
