# ============================================================
# setup_windows.ps1 — Instalação automática no VPS Windows
# Bot de Trading MT5 Dashboard v6.0
#
# Como usar:
#   1. Abre o PowerShell como Administrador no VPS
#   2. Cola este comando e prime Enter:
#      Set-ExecutionPolicy Bypass -Scope Process -Force
#   3. Depois corre o script:
#      .\setup_windows.ps1
# ============================================================

$ErrorActionPreference = "Stop"
$ProjectPath = "C:\dashboard"

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Setup Bot MT5 Dashboard — VPS Windows" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Chocolatey (gestor de pacotes Windows) ────────────────
Write-Host "[1/7] A instalar Chocolatey..." -ForegroundColor Yellow
if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
    Set-ExecutionPolicy Bypass -Scope Process -Force
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
    Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    Write-Host "  Chocolatey instalado." -ForegroundColor Green
} else {
    Write-Host "  Chocolatey ja instalado." -ForegroundColor Green
}

# ── 2. Node.js 20 ────────────────────────────────────────────
Write-Host "[2/7] A instalar Node.js 20..." -ForegroundColor Yellow
choco install nodejs-lts -y --version 20.19.0 2>&1 | Out-Null
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
Write-Host "  Node.js $(node --version) instalado." -ForegroundColor Green

# ── 3. Python 3.11 ───────────────────────────────────────────
Write-Host "[3/7] A instalar Python 3.11..." -ForegroundColor Yellow
choco install python311 -y 2>&1 | Out-Null
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
Write-Host "  Python $(python --version) instalado." -ForegroundColor Green

# ── 4. PM2 (gestor de processos Node.js) ─────────────────────
Write-Host "[4/7] A instalar PM2..." -ForegroundColor Yellow
npm install -g pm2 2>&1 | Out-Null
npm install -g pm2-windows-startup 2>&1 | Out-Null
Write-Host "  PM2 instalado." -ForegroundColor Green

# ── 5. NSSM (para correr Python como serviço Windows) ────────
Write-Host "[5/7] A instalar NSSM..." -ForegroundColor Yellow
choco install nssm -y 2>&1 | Out-Null
Write-Host "  NSSM instalado." -ForegroundColor Green

# ── 6. Dependências Python ───────────────────────────────────
Write-Host "[6/7] A instalar dependencias Python..." -ForegroundColor Yellow
pip install MetaTrader5 flask requests 2>&1 | Out-Null
Write-Host "  MetaTrader5, Flask, requests instalados." -ForegroundColor Green

# ── 7. Criar pasta e instalar dependências Node ──────────────
Write-Host "[7/7] A preparar pasta do projecto..." -ForegroundColor Yellow
if (-not (Test-Path $ProjectPath)) {
    New-Item -ItemType Directory -Path $ProjectPath | Out-Null
}
Write-Host "  Pasta $ProjectPath pronta." -ForegroundColor Green

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  Instalacao base concluida!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "PROXIMOS PASSOS:" -ForegroundColor Cyan
Write-Host "  1. Copia os ficheiros do projecto para $ProjectPath"
Write-Host "  2. Copia deploy\.env.production para $ProjectPath\.env"
Write-Host "  3. Preenche o .env com os dados da nova conta FTMO"
Write-Host "  4. Corre: cd $ProjectPath && npm install"
Write-Host "  5. Instala e abre o MT5 (ver guia)"
Write-Host "  6. Corre: .\deploy\start_services.ps1"
Write-Host ""
