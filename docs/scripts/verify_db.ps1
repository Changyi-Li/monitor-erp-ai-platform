param(
  # Path to apps/api/.env, from which DATABASE_URL / DATABASE_OWNER_URL are read.
  # NOT named $EnvPath: collides with $env:Path (PowerShell variable names are case-insensitive).
  [string]$ConfigPath = "apps/api/.env",
  # psql executable path; empty = auto-discover via PATH / common install dirs.
  [string]$PsqlPath = "",
  # Manual override of the required-tables list. When empty, the list is derived
  # from the drizzle schema (pgTable('...') first argument, multi-line form).
  # When provided, a drift warning is printed if it differs from the schema list.
  [string[]]$RequiredTables = @(),
  # Path to the drizzle schema file used to derive the table list.
  [string]$SchemaPath = "apps/api/src/database/schema.ts"
)

# IMPORTANT: keep this file ASCII-only. Windows PowerShell 5.1 reads scripts
# without a UTF-8 BOM as ANSI; non-ASCII bytes in the param block silently
# break parameter binding. See dev-environment-quirks memory.
#
# v2 (issue #46): diagnostics replace guesswork.
# - journal state is measured (drizzle schema / __drizzle_migrations records)
#   via the owner URL, when present - app_tenant_user cannot see drizzle schema
# - DATABASE_URL vs DATABASE_OWNER_URL database-name mismatch is flagged
# - required-tables list is derived from schema.ts (drift-proof); manual
#   override still possible and checked for drift
# - on failure, the printed fix matches the measured state

$ErrorActionPreference = 'Stop'

# ---- 1. read DATABASE_URL + optional DATABASE_OWNER_URL from .env ----
if (-not (Test-Path $ConfigPath)) {
  Write-Host "[verify_db] FAIL: .env not found at $ConfigPath" -ForegroundColor Red
  exit 2
}
$envLines = @(Get-Content $ConfigPath)
function Get-EnvValue([string]$key) {
  $line = $envLines | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return (($line -split '=', 2)[1]).Trim().Trim('"').Trim("'")
}
$dbUrl = Get-EnvValue 'DATABASE_URL'
if (-not $dbUrl) {
  Write-Host "[verify_db] FAIL: DATABASE_URL not found in $ConfigPath" -ForegroundColor Red
  exit 2
}
$ownerUrl = Get-EnvValue 'DATABASE_OWNER_URL' # optional; enables journal diagnostics
$dbName = if ($dbUrl -match '/([^/]+)$') { $Matches[1] } else { '(unknown)' }

# ---- 2. locate psql ----
$psqlExe = $PsqlPath
if (-not $psqlExe) {
  $cmd = Get-Command psql -ErrorAction SilentlyContinue
  if ($cmd) { $psqlExe = $cmd.Source }
}
if (-not $psqlExe) {
  # fallback: common PostgreSQL install dirs
  # NOTE: PS 5.1 cannot do $x = foreach {...}; use pipeline ForEach-Object instead.
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
  Write-Host "[verify_db] FAIL: psql not found (pass -PsqlPath)" -ForegroundColor Red
  exit 2
}

# ---- 3. derive required tables from schema.ts (or use manual override) ----
$schemaTables = @()
if (Test-Path $SchemaPath) {
  $content = Get-Content $SchemaPath -Raw
  $schemaTables = @(
    [regex]::Matches($content, "pgTable\(\s*'([^']+)'") |
      ForEach-Object { $_.Groups[1].Value } |
      Sort-Object -Unique
  )
}
if ($RequiredTables.Count -eq 0) {
  if ($schemaTables.Count -gt 0) {
    $RequiredTables = $schemaTables
  } else {
    # fallback: built-in list (mirror of the schema as of 2026-08); a warning
    # is printed so a schema read failure never disables the sentinel silently
    Write-Host "[verify_db] WARN: cannot derive tables from $SchemaPath - using built-in list" -ForegroundColor Yellow
    $RequiredTables = @(
      'users', 'refresh_tokens', 'customers', 'user_tenants',
      'projects', 'project_members', 'issues', 'issue_comments', 'issue_links',
      'document_syncs', 'blueprints', 'blueprint_versions',
      'project_stages', 'project_risks', 'meeting_minutes', 'minute_attachments',
      'kb_documents', 'kb_document_versions', 'import_staged_documents',
      'manual_generations', 'manual_chapters', 'audit_logs',
      'ai_conversations', 'ai_messages', 'langgraph_checkpoints',
      'langgraph_checkpoint_writes', 'ai_usage'
    )
  }
} elseif ($schemaTables.Count -gt 0) {
  # manual override provided: check for drift against the schema list
  $driftMissing = @($schemaTables | Where-Object { $_ -notin $RequiredTables })
  $driftExtra = @($RequiredTables | Where-Object { $_ -notin $schemaTables })
  if ($driftMissing.Count -gt 0 -or $driftExtra.Count -gt 0) {
    Write-Host "[verify_db] WARN: -RequiredTables differs from schema.ts ($SchemaPath):" -ForegroundColor Yellow
    $driftMissing | ForEach-Object { Write-Host "  schema has but override misses: $_" -ForegroundColor Yellow }
    $driftExtra | ForEach-Object { Write-Host "  override has but schema lacks: $_" -ForegroundColor Yellow }
    Write-Host "  (drift can cause false negatives; keep them in sync)" -ForegroundColor Yellow
  }
}

# ---- 4. list tables in public schema ----
Write-Host "[verify_db] Checking tables in database '$dbName'..."
# NOTE: options must come BEFORE the connection string - psql treats the first
# non-option argument as DBNAME and silently ignores everything after it
# ("ignoring extra command-line argument" warning, query never runs).
# --dbname= is explicit to avoid any positional ambiguity.
$out = & $psqlExe -t -A --dbname=$dbUrl -c "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public';" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "[verify_db] FAIL: cannot connect / query database: $($out -join ' ')" -ForegroundColor Red
  exit 2
}
$existing = @($out | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })

# ---- 5. compare against required list ----
$missing = @($RequiredTables | Where-Object { $_ -notin $existing })
if ($missing.Count -eq 0) {
  Write-Host "[verify_db] OK: all $($RequiredTables.Count) required tables exist in '$dbName'." -ForegroundColor Green
  exit 0
}

# ---- 6. FAIL: measure the state instead of guessing, then give the right fix ----
Write-Host "[verify_db] FAIL: $($missing.Count)/$($RequiredTables.Count) required tables are MISSING in '$dbName':" -ForegroundColor Red
$missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }

# 6a. journal state via owner connection (app role may not read drizzle schema)
$journalState = 'unknown'
if ($ownerUrl) {
  $nsOut = & $psqlExe -t -A --dbname=$ownerUrl -c "SELECT 1 FROM pg_namespace WHERE nspname='drizzle';" 2>&1
  if ($LASTEXITCODE -eq 0 -and $nsOut.Trim()) {
    $tblOut = (& $psqlExe -t -A --dbname=$ownerUrl -c "SELECT to_regclass('drizzle.__drizzle_migrations');" 2>&1).Trim()
    if ($tblOut -match '__drizzle_migrations') {
      $cnt = (& $psqlExe -t -A --dbname=$ownerUrl -c "SELECT count(*) FROM drizzle.__drizzle_migrations;" 2>&1).Trim()
      $journalState = "journal-survived:$cnt"
    } else {
      $journalState = 'schema-only'
    }
  } else {
    $journalState = 'no-drizzle-schema'
  }
} else {
  $journalState = 'unknown-no-owner-url'
}

# 6b. URL database-name mismatch
if ($ownerUrl) {
  $ownerDbName = if ($ownerUrl -match '/([^/]+)$') { $Matches[1] } else { '(unknown)' }
  if ($ownerDbName -ne $dbName) {
    Write-Host "[verify_db] WARN: DATABASE_URL points to '$dbName' but DATABASE_OWNER_URL points to '$ownerDbName'." -ForegroundColor Yellow
    Write-Host "  If migrations ran against the owner URL, tables went to the WRONG database." -ForegroundColor Yellow
  }
}

# 6c. recovery guidance matching the measured state
Write-Host "Measured state: $journalState" -ForegroundColor Cyan
switch ($journalState) {
  'journal-survived*' {
    Write-Host "Cause: migration journal survived while business tables were wiped - drizzle would skip all migrations." -ForegroundColor Yellow
    Write-Host "Fix: 1) DROP SCHEMA IF EXISTS drizzle CASCADE;" -ForegroundColor Yellow
    Write-Host "     2) run 'pnpm db:migrate' with owner credentials (DATABASE_OWNER_URL)." -ForegroundColor Yellow
    Write-Host "     One-command recovery: powershell -File docs\scripts\recover_db.ps1" -ForegroundColor Yellow
  }
  'schema-only' {
    Write-Host "Cause: drizzle schema exists but the migration history table is missing - state is inconsistent." -ForegroundColor Yellow
    Write-Host "Fix: 1) DROP SCHEMA IF EXISTS drizzle CASCADE;" -ForegroundColor Yellow
    Write-Host "     2) run 'pnpm db:migrate' with owner credentials (DATABASE_OWNER_URL)." -ForegroundColor Yellow
  }
  'no-drizzle-schema' {
    Write-Host "Cause: no drizzle schema - migrations have never been applied to this database." -ForegroundColor Yellow
    Write-Host "Fix: run 'pnpm db:migrate' with owner credentials (DATABASE_OWNER_URL) - no DROP needed." -ForegroundColor Yellow
  }
  'unknown-no-owner-url' {
    Write-Host "Note: DATABASE_OWNER_URL is not set in $ConfigPath - journal diagnostics skipped." -ForegroundColor Yellow
    Write-Host "Fix: set DATABASE_OWNER_URL (owner credentials) in $ConfigPath, then run 'pnpm db:migrate'." -ForegroundColor Yellow
  }
  default {
    Write-Host "Cause: unknown - investigate manually." -ForegroundColor Yellow
  }
}
exit 1
