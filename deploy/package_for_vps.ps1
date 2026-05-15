$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$OutputDir = Join-Path $ProjectRoot "outputs"
$ZipPath = Join-Path $OutputDir "dashboard-vps-package.zip"

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

if (Test-Path $ZipPath) {
    Remove-Item $ZipPath -Force
}

$stagingDir = Join-Path $env:TEMP ("dashboard-vps-package-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stagingDir | Out-Null

$excludeDirs = @(
    ".git",
    ".codex-logs",
    "node_modules",
    "__pycache__",
    "outputs",
    "logs"
)

$excludeFiles = @(
    "larissa-barreto-global-educator-logo.jpg",
    "larissa-barreto-global-educator-logo.png"
)

Get-ChildItem -Path $ProjectRoot -Force | Where-Object {
    $name = $_.Name
    -not ($excludeDirs -contains $name) -and -not ($excludeFiles -contains $name)
} | ForEach-Object {
    Copy-Item $_.FullName -Destination $stagingDir -Recurse -Force
}

Compress-Archive -Path (Join-Path $stagingDir "*") -DestinationPath $ZipPath -CompressionLevel Optimal
Remove-Item $stagingDir -Recurse -Force

Write-Host ""
Write-Host "Pacote gerado com sucesso:" -ForegroundColor Green
Write-Host "  $ZipPath"
Write-Host ""
Write-Host "Envie este .zip para o VPS e extraia em C:\dashboard" -ForegroundColor Cyan
