# ============================================================
# start_services.ps1 — Arranca todos os servicos do bot
# Corre este script sempre que quiseres iniciar tudo no VPS
# ou após reiniciar o servidor.
# ============================================================

$ErrorActionPreference = "Stop"
$ProjectPath = "C:\dashboard"
$PythonPath  = (Get-Command python).Source

Write-Host ""
Write-Host "A arrancar servicos do Bot MT5..." -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path "$ProjectPath\logs")) {
    New-Item -ItemType Directory -Path "$ProjectPath\logs" | Out-Null
}

# ── 1. Node.js Dashboard via PM2 ─────────────────────────────
Write-Host "[1/3] Dashboard Node.js (PM2)..." -ForegroundColor Yellow
Set-Location $ProjectPath
pm2 delete dashboard 2>$null
pm2 start server.js --name dashboard --max-restarts 10 --restart-delay 5000
pm2 save
Write-Host "  Dashboard a correr em http://localhost:3000" -ForegroundColor Green

# ── 2. MT5 Feed Sync (lê MT5 e escreve mt5_feed.json) ────────
Write-Host "[2/3] MT5 Feed Sync..." -ForegroundColor Yellow
nssm stop mt5-feed 2>$null
nssm remove mt5-feed confirm 2>$null
nssm install mt5-feed $PythonPath "$ProjectPath\mt5_feed_sync.py"
nssm set mt5-feed AppDirectory $ProjectPath
nssm set mt5-feed AppStdout "$ProjectPath\logs\mt5_feed.log"
nssm set mt5-feed AppStderr "$ProjectPath\logs\mt5_feed_err.log"
nssm set mt5-feed Start SERVICE_AUTO_START
nssm start mt5-feed
Write-Host "  MT5 Feed Sync a correr." -ForegroundColor Green

# ── 3. Bot Webhook Receiver (Flask :5000) ────────────────────
Write-Host "[3/3] Bot Webhook Receiver..." -ForegroundColor Yellow
nssm stop mt5-bot 2>$null
nssm remove mt5-bot confirm 2>$null
nssm install mt5-bot $PythonPath "$ProjectPath\bot_webhook_receiver.py"
nssm set mt5-bot AppDirectory $ProjectPath
nssm set mt5-bot AppStdout "$ProjectPath\logs\bot.log"
nssm set mt5-bot AppStderr "$ProjectPath\logs\bot_err.log"
nssm set mt5-bot Start SERVICE_AUTO_START
nssm start mt5-bot
Write-Host "  Bot Webhook a correr em http://localhost:5000" -ForegroundColor Green

# ── Criar pasta de logs se não existir ───────────────────────
Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  Todos os servicos arrancados!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "Comandos uteis:" -ForegroundColor Cyan
Write-Host "  pm2 logs dashboard     -- ver logs do Node.js"
Write-Host "  pm2 restart dashboard  -- reiniciar apos alteracao no codigo"
Write-Host "  nssm status mt5-feed   -- estado do feed MT5"
Write-Host "  nssm status mt5-bot    -- estado do bot webhook"
Write-Host "  pm2 status             -- ver todos os processos"
Write-Host ""
