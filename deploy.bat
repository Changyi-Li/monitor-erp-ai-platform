@echo off
rem deploy.bat - Update the deployment to the latest commit (NSSM service mode).
rem Edit the three variables below to match your deployment, then double-click
rem or run from cmd. See docs/deploy-windows.md section 7.
setlocal

set APP_ROOT=C:\MonitorAdaptations\monitor-erp-ai-platform
set API_SERVICE=MonitorAiPlatformApi
set WEB_SERVICE=MonitorAiPlatformWeb

cd /d "%APP_ROOT%" || goto :fail

echo [1/5] Checking working tree
for /f %%a in ('git status --porcelain') do set DIRTY=1
if defined DIRTY (
  echo Local changes found - aborting. Commit or stash them first:
  git status --porcelain
  exit /b 1
)

echo [2/5] git pull
call git pull || goto :fail

echo [3/5] pnpm install
call pnpm install --frozen-lockfile || goto :fail

echo [4/5] pnpm build
call pnpm build || goto :fail

echo [4.5/5] DB table sanity check
rem Aborts if required business tables are missing in the database (e.g. the
rem schema was wiped while the drizzle journal survived - drizzle would
rem otherwise report a successful no-op migration). Owner credentials are NOT
rem needed: the restricted app_tenant_user is read-only enough for this.
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_ROOT%\docs\scripts\verify_db.ps1" -ConfigPath "%APP_ROOT%\apps\api\.env" || goto :fail

echo [4.6/5] DB migration
rem Required on EVERY deploy, not just when an update ships a migration:
rem drizzle migrations are idempotent (skips already-applied ones), and this
rem step is the only thing standing between new code and the schema it needs
rem (2026-08 incidents: code deployed without migrations -> login failed with
rem a missing column / wiped tables). Owner credentials are read from
rem apps/api/.env DATABASE_OWNER_URL - migrations contain CREATE ROLE/GRANT
rem and the restricted app_tenant_user cannot run them. Missing credentials
rem or a failed migration ABORTS the deploy: a half-deployed state (new code,
rem old schema) is worse than no deploy.
rem The .env parse runs inside run_migration.ps1 (PowerShell), not in cmd: a
rem cmd for /f parenthesized block misparsed under LF line endings on the
rem server and reported DATABASE_OWNER_URL as "not defined" although the key
rem existed, silently disabling this step (issue #47). .gitattributes now
rem pins *.bat to CRLF as well.
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_ROOT%\docs\scripts\run_migration.ps1" -ConfigPath "%APP_ROOT%\apps\api\.env" || goto :fail

echo [5/5] Restarting services
net stop %API_SERVICE%
net stop %WEB_SERVICE%
net start %API_SERVICE%
net start %WEB_SERVICE%
echo Done.
exit /b 0

:fail
echo Step failed with errorlevel %ERRORLEVEL%
if exist "%APP_ROOT%\docs\scripts\recover_db.ps1" echo DB recovery if the failure is DB-related: powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_ROOT%\docs\scripts\recover_db.ps1"
exit /b 1
