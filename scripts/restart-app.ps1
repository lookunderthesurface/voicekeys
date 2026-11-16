# Restart the installed VoiceKeys WITHOUT opening a browser tab.
# Why: VoiceKeys.exe opens the web UI on every start; when an agent restarts it
# repeatedly during development that means one new Edge tab per restart.
# `--no-browser` (launcher.cs) suppresses that; use this script for dev restarts.
#
# Usage: pwsh -File scripts/restart-app.ps1 [-Sync]
param([switch]$Sync)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$inst = Join-Path $env:LOCALAPPDATA 'Programs\VoiceKeys'
$exe = Join-Path $inst 'VoiceKeys.exe'

Write-Host '== stop =='
Get-Process -Name 'VoiceKeys' -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Kill() } catch { } }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'Programs\\VoiceKeys' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch { } }
Start-Sleep -Seconds 2

if ($Sync) {
  Write-Host '== sync code =='
  node (Join-Path $root 'scripts\sync-to-install.cjs')
}

Write-Host '== start (no browser) =='
$job = Start-Job -ScriptBlock { param($e) & $e --no-browser } -ArgumentList $exe
Start-Sleep -Seconds 15
Remove-Job -Force $job -ErrorAction SilentlyContinue

Write-Host '== wait for api =='
$ok = $false
$state = $null
for ($i = 0; $i -lt 30; $i++) {
  try {
    $state = (Invoke-WebRequest 'http://127.0.0.1:19600/api/state' -UseBasicParsing -TimeoutSec 3).Content | ConvertFrom-Json
    $ok = $true
    break
  } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $ok) { Write-Host '  FAILED: api not up' -ForegroundColor Red; exit 1 }
Write-Host ('  ok  asrReady=' + $state.asrReady + '  words=' + @($state.words).Count + '  capture=' + $state.capture.count) -ForegroundColor Green
