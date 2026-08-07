# install_service.ps1 - Register Monitor ERP AI Platform as Windows services (NSSM)
#
# Usage (Administrator PowerShell):
#   powershell -ExecutionPolicy Bypass -File docs\scripts\install_service.ps1 -AppRoot D:\apps\monitor-erp-ai-platform -WebPort 8080
#
# Prerequisites:
#   1. Node 24.x installed and on PATH; `pnpm build` already run (dist/ exists)
#   2. NSSM downloaded (https://nssm.cc/download), nssm.exe on PATH or next to this script
#
# Result: two services `monitor-api` and `monitor-web` in services.msc -
# auto-start at boot, auto-restart on crash. Mutually exclusive with PM2;
# do NOT run both at the same time (they would fight over the same ports).

param(
    [string]$AppRoot = 'D:\apps\monitor-erp-ai-platform',  # deployment directory
    [int]$WebPort = 3000,                                  # public web port (keep WEB_URL in sync)
    [int]$ApiPort = 3001,                                  # API port (normally keep default)
    [string]$ApiServiceName = 'monitor-api',               # Windows service name for the API
    [string]$WebServiceName = 'monitor-web'                # Windows service name for the web
)

$ErrorActionPreference = 'Stop'

# 1. Require administrator
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'This script must run as Administrator.' }

# 2. Locate nssm.exe (PATH, or next to this script)
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) {
    $local = Join-Path $PSScriptRoot 'nssm.exe'
    if (Test-Path $local) { $nssm = $local } else { throw 'nssm.exe not found: add it to PATH or place it next to this script.' }
}
Write-Host "Using NSSM: $nssm"

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node.exe not found: install Node 24.x first.' }

# 3. Sanity-check build artifacts.
#    pnpm does NOT hoist next to the workspace root: it lives under
#    apps\web\node_modules\next (check both locations to be safe).
$apiDist = Join-Path $AppRoot 'apps\api\dist\main.js'
$webBin  = $null
foreach ($candidate in @(
    (Join-Path $AppRoot 'apps\web\node_modules\next\dist\bin\next'),
    (Join-Path $AppRoot 'node_modules\next\dist\bin\next')
)) {
    if (Test-Path $candidate) { $webBin = $candidate; break }
}
if (-not (Test-Path $apiDist)) { throw "API entry not found: $apiDist (run pnpm build first)" }
if (-not $webBin)              { throw 'Next launcher not found (run pnpm install first)' }
Write-Host "Using Next: $webBin"

$logDir = Join-Path $AppRoot 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null

# 4. Remove previous instances (idempotent re-install)
foreach ($name in @($ApiServiceName, $WebServiceName)) {
    if (Get-Service $name -ErrorAction SilentlyContinue) {
        & $nssm stop $name
        & $nssm remove $name confirm
    }
}

# 5. Install API service.
#    AppDirectory MUST be apps\api: @nestjs/config reads .env from the working
#    directory (DATABASE_URL / LLM keys / WEB_URL live there).
& $nssm install $ApiServiceName $node $apiDist
& $nssm set $ApiServiceName AppDirectory (Join-Path $AppRoot 'apps\api')
& $nssm set $ApiServiceName AppEnvironmentExtra "NODE_ENV=production" "PORT=$ApiPort"
& $nssm set $ApiServiceName AppStdout (Join-Path $logDir 'api.log')
& $nssm set $ApiServiceName AppStderr (Join-Path $logDir 'api-err.log')
& $nssm set $ApiServiceName Description 'Monitor ERP AI Platform - NestJS API (embedded RAG/import workers)'

# 6. Install Web service (same-origin proxy /api/* -> 127.0.0.1:ApiPort)
& $nssm install $WebServiceName $node $webBin 'start' '-p' "$WebPort"
& $nssm set $WebServiceName AppDirectory (Join-Path $AppRoot 'apps\web')
& $nssm set $WebServiceName AppEnvironmentExtra "NODE_ENV=production" "API_URL=http://127.0.0.1:$ApiPort"
& $nssm set $WebServiceName AppStdout (Join-Path $logDir 'web.log')
& $nssm set $WebServiceName AppStderr (Join-Path $logDir 'web-err.log')
& $nssm set $WebServiceName Description "Monitor ERP AI Platform - Next.js Web (port $WebPort)"

# 7. Start
& $nssm start $ApiServiceName
& $nssm start $WebServiceName

Write-Host ''
Write-Host 'Installed. Control via services.msc or:'
Write-Host "  net start/stop $ApiServiceName"
Write-Host "  net start/stop $WebServiceName"
Write-Host "Logs: $logDir"
Write-Host 'Reminder: WEB_URL in apps\api\.env must point at the public entry'
Write-Host "  (e.g. http://<address>:$WebPort) and the firewall must allow port $WebPort."
