param(
  # Path to apps/api/.env, from which DATABASE_URL is read.
  # NOT named $EnvPath: collides with $env:Path (PowerShell variable names are case-insensitive).
  [string]$ConfigPath = "apps/api/.env",
  # psql executable path; empty = auto-discover via PATH / common install dirs.
  [string]$PsqlPath = "",
  # Business tables that must exist (mirror of apps/api/src/database/schema.ts pgTables;
  # keep in sync when tables are added).
  [string[]]$RequiredTables = @(
    'users', 'refresh_tokens', 'customers', 'user_tenants',
    'projects', 'project_members', 'issues', 'issue_comments', 'issue_links',
    'document_syncs', 'blueprints', 'blueprint_versions',
    'project_stages', 'project_risks', 'meeting_minutes', 'minute_attachments',
    'kb_documents', 'kb_document_versions', 'import_staged_documents',
    'manual_generations', 'manual_chapters', 'audit_logs',
    'ai_conversations', 'ai_messages', 'langgraph_checkpoints',
    'langgraph_checkpoint_writes', 'ai_usage'
  )
)

# IMPORTANT: keep this file ASCII-only. Windows PowerShell 5.1 reads scripts
# without a UTF-8 BOM as ANSI; non-ASCII bytes in the param block silently
# break parameter binding. See dev-environment-quirks memory.

$ErrorActionPreference = 'Stop'

# ---- 1. read DATABASE_URL from .env ----
if (-not (Test-Path $ConfigPath)) {
  Write-Host "[verify_db] FAIL: .env not found at $ConfigPath" -ForegroundColor Red
  exit 2
}
$line = Get-Content $ConfigPath | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
if (-not $line) {
  Write-Host "[verify_db] FAIL: DATABASE_URL not found in $ConfigPath" -ForegroundColor Red
  exit 2
}
$dbUrl = (($line -split '=', 2)[1]).Trim().Trim('"').Trim("'")
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

# ---- 3. list tables in public schema ----
Write-Host "[verify_db] Checking tables in database '$dbName'..."
$out = & $psqlExe $dbUrl -t -A -c "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public';" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "[verify_db] FAIL: cannot connect / query database: $($out -join ' ')" -ForegroundColor Red
  exit 2
}
$existing = @($out | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })

# ---- 4. compare against required list ----
$missing = @($RequiredTables | Where-Object { $_ -notin $existing })
if ($missing.Count -gt 0) {
  Write-Host "[verify_db] FAIL: $($missing.Count)/$($RequiredTables.Count) required tables are MISSING in '$dbName':" -ForegroundColor Red
  $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  Write-Host "Possible cause: business tables were wiped while the drizzle journal survived." -ForegroundColor Yellow
  Write-Host "Fix: DROP SCHEMA IF EXISTS drizzle CASCADE; then run 'pnpm db:migrate' (owner credentials)." -ForegroundColor Yellow
  exit 1
}
Write-Host "[verify_db] OK: all $($RequiredTables.Count) required tables exist in '$dbName'." -ForegroundColor Green
exit 0
