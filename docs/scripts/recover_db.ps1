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
#   - lets verify_db.ps1 (the deploy sentinel) decide whether tables are
#     complete - the same schema-derived table list, no second implementation
#     here (issue #47 AC3)
#   - measures the drizzle journal state via the OWNER connection (the
#     restricted app_tenant_user cannot see the drizzle schema)
#   - wipes ONLY in the broken-schema shape (tables missing): the drizzle
#     journal AND the remaining public tables are dropped, then all migrations
#     re-run (empty rebuild). Remaining tables would collide with the CREATE
#     TABLE statements of a full re-run (drizzle-kit emits no IF NOT EXISTS),
#     so a partial wipe is not recoverable otherwise. Tables complete ->
#     migrations are re-run idempotently with data preserved.
#   - reuses run_migration.ps1 for the actual migration (same code path as
#     deploy.bat [4.6/5])
#   - verifies with verify_db.ps1 afterwards (fail-closed: a failed check is
#     an error, never success)
# The wipe happens only after an explicit confirmation, and only when the
# table check already found the schema broken.

$ErrorActionPreference = 'Stop'

# Shared helpers (Get-EnvValue / Invoke-Psql) live in ps-lib.ps1 - one
# implementation for all docs/scripts (issue #47 AC3). $envLines and $psqlExe
# are set below before the functions are called.
. "$PSScriptRoot\ps-lib.ps1"

# ---- 1. read DATABASE_URL + DATABASE_OWNER_URL from .env ----
if (-not (Test-Path $ConfigPath)) {
  Write-Host "[recover_db] FAIL: .env not found at $ConfigPath" -ForegroundColor Red
  exit 2
}
$envLines = @(Get-Content $ConfigPath)
$ownerUrl = Get-EnvValue 'DATABASE_OWNER_URL'
if (-not $ownerUrl) {
  Write-Host "[recover_db] FAIL: DATABASE_OWNER_URL not found in $ConfigPath" -ForegroundColor Red
  Write-Host "Owner credentials are required (migrations contain CREATE ROLE/GRANT)." -ForegroundColor Red
  Write-Host "See docs/deploy-windows.md section 4." -ForegroundColor Red
  exit 2
}

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

# ---- 3. work from the repo root ----
# verify_db.ps1 derives the table list from schema.ts via a relative path, and
# run_migration.ps1 needs `pnpm db:migrate` to resolve the root package script.
# Push instead of cd: the caller's directory is restored on exit.
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Push-Location $repoRoot
try {
  # ---- 4. verdict: verify_db.ps1 (table list, schema-derived) ----
  # exit 0 = all required tables present; exit 1 = missing; exit 2 = could
  # not measure (connection/config) - abort in that case, never guess.
  & "$PSScriptRoot\verify_db.ps1" -ConfigPath $ConfigPath
  $verifyCode = $LASTEXITCODE
  if ($verifyCode -eq 2) {
    Write-Host "[recover_db] FAIL: DB state could not be measured (see verify_db output above)." -ForegroundColor Red
    exit 2
  }
  $missingTables = ($verifyCode -eq 1)

  # ---- 5. journal state via owner connection ----
  # NOTE: options must come BEFORE the connection string - psql treats the
  # first non-option argument as DBNAME and silently ignores the rest.
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

  # ---- 6. decision ----
  # Incident shape (2026-08): tables went missing while the journal survived
  # - drizzle skips every migration. Rebuilding from the empty schema is the
  # only reliable path: remaining tables would COLLIDE with the CREATE TABLE
  # statements of a full re-run (drizzle-kit does not emit IF NOT EXISTS), so
  # the wipe covers journal + all public tables together.
  #   verify 0 + journal     -> re-run migrations (idempotent, data kept)
  #   verify 0 + no journal  -> journal lost but tables complete: re-running
  #                             migrations would collide, and healthy data is
  #                             never deleted automatically - abort, manual
  #   verify 1 + any journal -> wipe journal + public tables, full rebuild
  $wipeAndRebuild = $missingTables
  if ($verifyCode -eq 0 -and -not $journalPresent) {
    Write-Host "[recover_db] FAIL: tables are complete but the drizzle journal is missing." -ForegroundColor Red
    Write-Host "Re-running migrations from scratch would collide with the existing tables, and" -ForegroundColor Red
    Write-Host "this script never deletes healthy data automatically. Investigate how the" -ForegroundColor Red
    Write-Host "journal was lost; the tables themselves are fine." -ForegroundColor Red
    exit 2
  }

  Write-Host "[recover_db] Measured state:" -ForegroundColor Cyan
  Write-Host "  tables      : $(if ($missingTables) { 'MISSING (see verify_db output above)' } else { 'all required tables present' })"
  if ($journalPresent) {
    Write-Host "  journal     : present ($migCount migration(s) recorded)"
  } else {
    Write-Host "  journal     : absent"
  }
  if ($wipeAndRebuild) {
    Write-Host "  plan        : WIPE drizzle journal + all public tables, then re-run all migrations (empty rebuild)" -ForegroundColor Yellow
  } else {
    Write-Host "  plan        : re-run migrations (journal kept, data preserved)" -ForegroundColor Yellow
  }

  # ---- 7. confirm before touching anything ----
  if (-not $SkipConfirm) {
    if ($wipeAndRebuild) {
      Write-Host "WARNING: the wipe is destructive - all remaining data in the public tables is" -ForegroundColor Red
      Write-Host "removed. It is only offered because the table check already found the schema" -ForegroundColor Red
      Write-Host "broken. Ensure a backup exists if any remaining data matters." -ForegroundColor Red
    }
    $answer = Read-Host "Continue? (y/N)"
    if ($answer -notmatch '^[yY]') {
      Write-Host "[recover_db] Aborted - no changes made." -ForegroundColor Yellow
      exit 0
    }
  }

  # ---- 8. wipe (journal + all public tables), then run migrations ----
  if ($wipeAndRebuild) {
    Write-Host "[recover_db] Wiping drizzle journal + all public tables (empty-schema rebuild) ..."
    $r = Invoke-Psql $ownerUrl "DROP SCHEMA IF EXISTS drizzle CASCADE;"
    if ($r.Code -ne 0) {
      Write-Host "[recover_db] FAIL: could not drop drizzle schema: $($r.Out -join ' ')" -ForegroundColor Red
      exit 2
    }
    $r = Invoke-Psql $ownerUrl 'DO $$ DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname=''public'' LOOP EXECUTE ''DROP TABLE public.'' || quote_ident(r.tablename) || '' CASCADE''; END LOOP; END $$;'
    if ($r.Code -ne 0) {
      Write-Host "[recover_db] FAIL: could not drop public tables: $($r.Out -join ' ')" -ForegroundColor Red
      exit 2
    }
  }
  & "$PSScriptRoot\run_migration.ps1" -ConfigPath $ConfigPath
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    Write-Host "[recover_db] FAIL: migrations did not complete (exit $code)." -ForegroundColor Red
    exit $code
  }

  # ---- 9. verify with the sentinel again (fail-closed) ----
  & "$PSScriptRoot\verify_db.ps1" -ConfigPath $ConfigPath
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    Write-Host "[recover_db] FAIL: verification did not pass after migration (exit $code) - see output above." -ForegroundColor Red
    exit 1
  }
  Write-Host "[recover_db] Done - all required tables verified." -ForegroundColor Green
  Write-Host "Restart the services if the app was running:" -ForegroundColor Green
  Write-Host "  net stop MonitorAiPlatformApi && net stop MonitorAiPlatformWeb" -ForegroundColor Green
  Write-Host "  net start MonitorAiPlatformApi && net start MonitorAiPlatformWeb" -ForegroundColor Green
  exit 0
} finally {
  Pop-Location
}
