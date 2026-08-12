param(
  # Path to apps/api/.env (or .env.test), from which DATABASE_OWNER_URL is read.
  # NOT named $EnvPath: collides with $env:Path (PowerShell variable names are
  # case-insensitive).
  [string]$ConfigPath = "apps/api/.env"
)

# IMPORTANT: keep this file ASCII-only. Windows PowerShell 5.1 reads scripts
# without a UTF-8 BOM as ANSI; non-ASCII bytes in the param block silently
# break parameter binding. See dev-environment-quirks memory.
#
# run_migration.ps1 (issue #47): applies drizzle migrations with owner
# credentials. Called by deploy.bat [4.6/5].
#
# Why the .env parse lives here (PowerShell) instead of cmd: a cmd `for /f`
# parenthesized block misparsed under LF line endings on the server and
# repeatedly reported DATABASE_OWNER_URL as "not defined" although the key
# existed - which silently disabled the only migration step of the deploy
# (code deployed without migrations -> missing columns / wiped tables, 2026-08
# incidents). The exit code is propagated so the batch `|| goto :fail` works.

$ErrorActionPreference = 'Stop'

# Shared helpers (Get-EnvValue / Invoke-Psql) live in ps-lib.ps1 - one
# implementation for all docs/scripts (issue #47 AC3).
. "$PSScriptRoot\ps-lib.ps1"

if (-not (Test-Path $ConfigPath)) {
  Write-Host "[run_migration] FAIL: .env not found at $ConfigPath" -ForegroundColor Red
  exit 2
}
$envLines = @(Get-Content $ConfigPath)
$ownerUrl = Get-EnvValue 'DATABASE_OWNER_URL'
if (-not $ownerUrl) {
  Write-Host "[run_migration] FAIL: DATABASE_OWNER_URL not found in $ConfigPath" -ForegroundColor Red
  Write-Host "Add owner credentials (postgres://postgres:...@localhost:5432/monitor_erp)" -ForegroundColor Red
  Write-Host "to apps\api\.env to enable migrations. See docs/deploy-windows.md section 4." -ForegroundColor Red
  exit 2
}

# Migrations contain CREATE ROLE/GRANT and must run as the table owner - the
# restricted app_tenant_user cannot do that. DATABASE_URL is inherited by the
# pnpm subprocess. Work from the repo root (this script lives in docs/scripts,
# so the root is two levels up) so `pnpm db:migrate` resolves the root script
# (pnpm --filter @monitor/api db:migrate) no matter where the caller ran from;
# the caller's directory is restored afterwards.
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$env:DATABASE_URL = $ownerUrl
Write-Host "[run_migration] Applying drizzle migrations (owner credentials) ..."
Push-Location $repoRoot
try {
  & pnpm db:migrate
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($code -ne 0) {
  Write-Host "[run_migration] FAIL: pnpm db:migrate exited with $code" -ForegroundColor Red
  Write-Host "Recovery: powershell -File docs\scripts\recover_db.ps1" -ForegroundColor Red
} else {
  Write-Host "[run_migration] OK: migrations applied." -ForegroundColor Green
}
exit $code
