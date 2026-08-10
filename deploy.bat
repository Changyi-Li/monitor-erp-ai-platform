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

rem Uncomment the three lines below when this update includes a DB migration
rem (owner credentials required - see docs/deploy-windows.md section 4):
rem set DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/monitor_erp
rem call pnpm db:migrate || goto :fail
rem set DATABASE_URL=

echo [5/5] Restarting services
net stop %API_SERVICE%
net stop %WEB_SERVICE%
net start %API_SERVICE%
net start %WEB_SERVICE%
echo Done.
exit /b 0

:fail
echo Step failed with errorlevel %ERRORLEVEL%
exit /b 1
