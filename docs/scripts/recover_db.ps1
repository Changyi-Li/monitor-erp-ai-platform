param(
  # Path to apps/api/.env (or .env.test), from which DATABASE_URL and
  # DATABASE_OWNER_URL are read. NOT named $EnvPath: collides with $env:Path
  # (PowerShell variable names are case-insensitive).
  [string]$ConfigPath = "apps/api/.env",
  # psql executable path; empty = auto-discover via PATH / common install dirs.
  [string]$PsqlPath = "",
  # Skip the interactive confirmation prompts (for scripted / CI use).
  [switch]$SkipConfirm
)

# IMPORTANT: keep this file ASCII-only. Windows PowerShell 5.1 reads scripts
# without a UTF-8 BOM as ANSI; non-ASCII bytes in the param block silently
# break parameter binding. See dev-environment-quirks memory.
#
# recover_db.ps1 (issue #47): one-command recovery when the deploy's DB check
# fails with missing business tables.
#   - measures the drizzle journal state via the OWNER connection (the
#     restricted app_tenant_user cannot see the drizzle schema)
#   - drops the journal ONLY in the incident shape (journal survived while
#     business tables were wiped - drizzle would skip every migration);
#     if business tables still exist it just re-runs migrations (idempotent,
#     data preserved)
#   - reuses run_migration.ps1 for the actual migration (same code path as
#     deploy.bat [4.6/5])
#   - verifies the table count afterwards
# Business tables are never dropped: DROP SCHEMA drizzle CASCADE only removes
# the migration-history schema, never public.* data.

$ErrorActionPreference = 'Stop'

# ---- 1. read DATABASE_URL + DATABASE_OWNER_URL from .env ----
if (-not (Test-Path $ConfigPath)) {
  Write-Host "[recover_db] FAIL: .env not found at $ConfigPath" -ForegroundColor Red
  exit 2
}
$envLines = @(Get-Content $ConfigPath)
function Get-EnvValue([string]$key) {
  $line = $envLines | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return (($line -split '=', 2)[1]).Trim().Trim('"').Trim("'")
}
$dbUrl = Get-EnvValue 'DATABASE_URL'
$ownerUrl = Get-EnvValue 'DATABASE_OWNER_URL'
if (-not $ownerUrl) {
  Write-Host "[recover_db] FAIL: DATABASE_OWNER_URL not found in $ConfigPath" -ForegroundColor Red
  Write-Host "Owner credentials are required (migrations contain CREATE ROLE/GRANT)." -ForegroundColor Red
  Write-Host "See docs/deploy-windows.md section 4." -ForegroundColor Red
  exit 2
}
if (-not $dbUrl) { $dbUrl = $ownerUrl }

# ---- 2. locate psql (same discovery logic as verify_db.ps1) ----
$psqlExe = $PsqlPath
if (-not $psqlExe) {
  $cmd = Get-Command psql -ErrorAction SilentlyContinue
  if ($cmd) { $psqlExe = $cmd.Source }
}
if (-not $psqlExe) {
  # NOTE: PS 5.1 cannot do $x = foreach {...}; use pipeline ForEach-Object.
  $roots = @('C:\Program Files\PostgreSQL', 'D:\Program Files\PostgreSQL', 'C:\PostgreSQL')
  $candidates = @($roots | ForEach-Object {
    Get-ChildItem $_ -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName 'bin\psql.exe' } |
      Where-Object { Test-Path $_ }
  })
  # NOTE: do NOT index pipeline output with [0] - a single-element array gets
  # unwrapped to a scalar string, so [0] would index the first CHARACTER.
  if ($candidates) { $psqlExe = ($candidates | Sort-Object -Descending | Select-Object -First 1) }
}
if (-not $psqlExe -or -not (Test-Path $psqlExe)) {
  Write-Host "[recover_db] FAIL: psql not found (pass -PsqlPath)" -ForegroundColor Red
  exit 2
}

# ---- psql helper ----
# PS 5.1: `2>&1` on a native command wraps stderr lines in ErrorRecord; with
# $ErrorActionPreference=Stop the first stderr line (e.g. a psql NOTICE from
# DROP/CREATE, which comes out on stderr) becomes a TERMINATING error and the
# script dies mid-operation. Run the native call under Continue, capture
# stdout+stderr as plain text, restore Stop afterwards.
function Invoke-Psql([string]$url, [string]$sql) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $psqlExe -t -A --dbname=$url -c $sql 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  $lines = @($out | ForEach-Object { $_.ToString() } | Where-Object { $_ -ne '' })
  return @{ Code = $code; Out = $lines }
}

# ---- 3. measure the state (owner connection for journal, app for tables) ----
# NOTE: options must come BEFORE the connection string - psql treats the first
# non-option argument as DBNAME and silently ignores everything after it.
$r = Invoke-Psql $ownerUrl "SELECT 1 FROM pg_namespace WHERE nspname='drizzle';"
if ($r.Code -ne 0) {
  Write-Host "[recover_db] FAIL: cannot connect with owner credentials: $($r.Out -join ' ')" -ForegroundColor Red
  exit 2
}
$journalPresent = (($r.Out -join ' ').Trim() -ne '')
$migCount = 0
if ($journalPresent) {
  $r = Invoke-Psql $ownerUrl "SELECT to_regclass('drizzle.__drizzle_migrations');"
  if (($r.Out -join ' ').Trim() -match '__drizzle_migrations') {
    $r = Invoke-Psql $ownerUrl "SELECT count(*) FROM drizzle.__drizzle_migrations;"
    $migCount = ($r.Out -join ' ').Trim()
  }
}
$tblCount = '?'
$r = Invoke-Psql $dbUrl "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
if ($r.Code -eq 0) { $tblCount = ($r.Out -join ' ').Trim() }

# ---- 4. decide whether the journal must be dropped ----
# Incident shape (2026-08): journal survived while business tables were wiped.
# In that shape drizzle skips every migration, so the journal has to go.
# If business tables still exist, only re-run migrations (idempotent; journal
# records are kept, missing ones are applied) - data is preserved.
$dropJournal = $false
if ($journalPresent -and $tblCount -eq '0') {
  $dropJournal = $true
}

Write-Host "[recover_db] Measured state:" -ForegroundColor Cyan
Write-Host "  public business tables : $tblCount"
if ($journalPresent) {
  Write-Host "  drizzle journal         : present ($migCount migration(s) recorded)"
} else {
  Write-Host "  drizzle journal         : absent"
}
if ($dropJournal) {
  Write-Host "  plan                    : DROP drizzle journal, then re-run all migrations" -ForegroundColor Yellow
} elseif ($journalPresent) {
  Write-Host "  plan                    : re-run migrations (journal kept, data preserved)" -ForegroundColor Yellow
} else {
  Write-Host "  plan                    : run migrations from scratch (no journal present)" -ForegroundColor Yellow
}

# ---- 5. confirm before touching anything ----
if (-not $SkipConfirm) {
  $answer = Read-Host "Continue? (y/N)"
  if ($answer -notmatch '^[yY]') {
    Write-Host "[recover_db] Aborted - no changes made." -ForegroundColor Yellow
    exit 0
  }
}

# ---- 6. drop the journal if needed, then run migrations ----
if ($dropJournal) {
  Write-Host "[recover_db] Dropping drizzle journal (migration history only; business tables untouched) ..."
  $r = Invoke-Psql $ownerUrl "DROP SCHEMA IF EXISTS drizzle CASCADE;"
  if ($r.Code -ne 0) {
    Write-Host "[recover_db] FAIL: could not drop drizzle schema: $($r.Out -join ' ')" -ForegroundColor Red
    exit 2
  }
}
& "$PSScriptRoot\run_migration.ps1" -ConfigPath $ConfigPath
$code = $LASTEXITCODE
if ($code -ne 0) {
  Write-Host "[recover_db] FAIL: migrations did not complete (exit $code)." -ForegroundColor Red
  exit $code
}

# ---- 7. verify ----
$tblCount2 = '?'
$r = Invoke-Psql $dbUrl "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
if ($r.Code -eq 0) { $tblCount2 = ($r.Out -join ' ').Trim() }
Write-Host "[recover_db] After migration: $tblCount2 public business table(s)."
if ($tblCount2 -eq '0') {
  Write-Host "[recover_db] FAIL: 0 tables after migration - investigate manually." -ForegroundColor Red
  exit 1
}
Write-Host "[recover_db] Done. Restart the services if the app was running:" -ForegroundColor Green
Write-Host "  net stop MonitorAiPlatformApi && net stop MonitorAiPlatformWeb" -ForegroundColor Green
Write-Host "  net start MonitorAiPlatformApi && net start MonitorAiPlatformWeb" -ForegroundColor Green
exit 0
