# uninstall_service.ps1 - Remove Monitor ERP AI Platform Windows services (NSSM)
#
# Usage (Administrator PowerShell):
#   powershell -ExecutionPolicy Bypass -File docs\scripts\uninstall_service.ps1
#   (pass the same -ApiServiceName / -WebServiceName as install if customized)

param(
    [string]$ApiServiceName = 'monitor-api',
    [string]$WebServiceName = 'monitor-web'
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

foreach ($name in @($ApiServiceName, $WebServiceName)) {
    if (Get-Service $name -ErrorAction SilentlyContinue) {
        & $nssm stop $name
        & $nssm remove $name confirm
        Write-Host "Removed service: $name"
    } else {
        Write-Host "Service not present, skipping: $name"
    }
}

Write-Host 'Done. The deployment directory itself was left untouched.'
