# Shared helpers for docs/scripts/*.ps1 (issue #47 AC3: one .env parse + one
# psql invocation implementation, no copies per script). Dot-source it, then
# call the functions. Both read caller-scope variables that the calling
# script must set before the first call:
#   Get-EnvValue($key)  -> $envLines  (array of .env lines)
#   Invoke-Psql($url,$sql) -> $psqlExe (psql executable path)
#
# IMPORTANT: keep this file ASCII-only. Windows PowerShell 5.1 reads scripts
# without a UTF-8 BOM as ANSI; non-ASCII bytes in the param block silently
# break parameter binding. See dev-environment-quirks memory.

# .env value lookup: first line matching "^KEY=" (case-insensitive - .env
# keys are conventionally uppercase, the servers had an uppercase key).
# Value is trimmed of surrounding whitespace and quotes. Returns $null when
# the key is absent.
function Get-EnvValue([string]$key) {
  $line = $envLines | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return (($line -split '=', 2)[1]).Trim().Trim('"').Trim("'")
}

# psql runner. PS 5.1: `2>&1` on a native command wraps stderr lines in
# ErrorRecord; with $ErrorActionPreference=Stop the first stderr line (e.g.
# psql's "password authentication failed") becomes a TERMINATING error -
# exactly when connection-failure diagnostics need to run. Run the native
# call under Continue, capture stdout+stderr as plain text, restore Stop
# afterwards. Returns @{ Code; Out } where Out is the non-empty lines.
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
