# Omniforge daemon launcher (PowerShell). Use como alternativa ao .cmd.
# Pode ser invocado por Task Scheduler com "powershell -File <path>".

$ErrorActionPreference = 'Stop'

# cwd = repo root (this script is at scripts/start-daemon.ps1)
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $repoRoot

# Already running?
$status = & .\bin\omniforge.cmd daemon status 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Daemon ja esta rodando." -ForegroundColor Green
    Write-Host $status
    exit 0
}

Write-Host "Iniciando Omniforge daemon..." -ForegroundColor Cyan
& .\bin\omniforge.cmd daemon start
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERRO: daemon start falhou. Veja data\daemon.log" -ForegroundColor Red
    exit 1
}

$token = (Get-Content -Raw -Path 'data\daemon-token.txt').Trim()
Write-Host ""
Write-Host "Dashboard URL:" -ForegroundColor Cyan
Write-Host "  http://127.0.0.1:20129/dashboard?token=$token"
Write-Host ""
Write-Host "(Cookie persiste 30 dias)" -ForegroundColor DarkGray
