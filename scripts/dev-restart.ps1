# Restart the Mineradio dev instance (Electron loaded from this repo's node_modules).
# Only processes whose executable is this repo's electron.exe are stopped, so an
# installed Mineradio.exe keeps running.
[CmdletBinding()]
param(
  [int]$TimeoutSec = 25,
  # Opens Chrome DevTools for the launched instance so a probe can read the live renderer.
  # Chromium binds this to 127.0.0.1 only; 0 leaves it off. Used by tmp/cdp-*.js probes.
  [int]$DebugPort = 0
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ElectronExe = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'))

$pkgFile = Join-Path $RepoRoot 'package.json'
if (-not (Test-Path -LiteralPath $pkgFile)) {
  Write-Host '[FAIL] package.json not found next to this script.'
  exit 3
}
$pkg = Get-Content -LiteralPath $pkgFile -Raw -Encoding UTF8 | ConvertFrom-Json
$runtimeName = $pkg.mineradio.runtimeName
if ([string]::IsNullOrWhiteSpace($runtimeName)) { $runtimeName = $pkg.productName }
if ([string]::IsNullOrWhiteSpace($runtimeName)) { $runtimeName = 'Mineradio' }
if (-not [string]::IsNullOrWhiteSpace($env:MINERADIO_RUNTIME_NAME)) { $runtimeName = $env:MINERADIO_RUNTIME_NAME }

$stateFile = Join-Path (Join-Path $env:APPDATA $runtimeName) 'startup-state.json'
$errFile = Join-Path (Join-Path $env:APPDATA $runtimeName) 'startup-error.log'

function Get-RepoElectronPid {
  $found = @()
  $procs = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    $hit = $false
    if ($p.ExecutablePath) {
      try {
        $full = [IO.Path]::GetFullPath($p.ExecutablePath)
        $hit = [string]::Equals($full, $ElectronExe, [StringComparison]::OrdinalIgnoreCase)
      } catch {
        $hit = $false
      }
    }
    if (-not $hit -and $p.CommandLine) {
      $cl = $p.CommandLine.TrimStart()
      if ($cl.StartsWith('"')) { $cl = $cl.Substring(1) }
      $hit = $cl.StartsWith($ElectronExe, [StringComparison]::OrdinalIgnoreCase)
    }
    if ($hit) { $found += [int]$p.ProcessId }
  }
  return $found
}

if (-not (Test-Path -LiteralPath $ElectronExe)) {
  Write-Host '[FAIL] Electron runtime is missing:'
  Write-Host ('       ' + $ElectronExe)
  Write-Host '       Run "npm install", and if dist stays empty:'
  Write-Host '       node node_modules/electron/install.js'
  exit 3
}

$launchMs = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
$stoppedBefore = @()

$running = @(Get-RepoElectronPid)
if ($running.Count -gt 0) {
  $stoppedBefore = $running
  Write-Host ('[..] stopping ' + $running.Count + ' dev electron process(es): ' + ($running -join ', '))
  foreach ($procId in $running) {
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }
  $killDeadline = (Get-Date).AddSeconds(8)
  while ((Get-Date) -lt $killDeadline) {
    if (@(Get-RepoElectronPid).Count -eq 0) { break }
    Start-Sleep -Milliseconds 200
  }
  $leftover = @(Get-RepoElectronPid)
  if ($leftover.Count -gt 0) {
    Write-Host ('[WARN] still alive after 8s: ' + ($leftover -join ', ') + ' - the new instance may just focus the old window.')
  }
}

$LaunchArgs = @('.')
if ($DebugPort -gt 0) {
  $LaunchArgs += ('--remote-debugging-port=' + $DebugPort)
  Write-Host ('[..] devtools on 127.0.0.1:' + $DebugPort)
}

try {
  Start-Process -FilePath $ElectronExe -ArgumentList $LaunchArgs -WorkingDirectory $RepoRoot | Out-Null
} catch {
  Write-Host '[FAIL] could not start Electron:'
  Write-Host ('       ' + $_.Exception.Message)
  exit 4
}

Write-Host ('[..] waiting for startup-state.json (phase=ready), up to ' + $TimeoutSec + 's')
$state = $null
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 300
  if (-not (Test-Path -LiteralPath $stateFile)) { continue }
  try {
    $candidate = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    $candidate = $null
  }
  if ($candidate -and [int64]$candidate.startedAt -ge $launchMs) {
    $state = $candidate
    if ($state.phase -eq 'ready') { break }
    if ($state.phase -like '*fail*' -or $state.phase -like '*error*') { break }
  }
}

if ($state -and $state.phase -eq 'ready') {
  $port = 0
  foreach ($evt in $state.events) {
    if ($evt.phase -eq 'server-ready' -and $evt.port) { $port = [int]$evt.port }
  }
  $httpCode = 0
  if ($port -gt 0) {
    try {
      $resp = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/api/app/version') -UseBasicParsing -TimeoutSec 5
      $httpCode = [int]$resp.StatusCode
    } catch {
      $httpCode = 0
    }
  }
  Write-Host ('[OK] ready  pid=' + $state.pid + '  port=' + $port + '  GET /api/app/version=' + $httpCode)
  if ($stoppedBefore.Count -gt 0) { Write-Host '     (previous dev instance was stopped)' }
  if ($httpCode -eq 200) { exit 0 }
  exit 2
}

Write-Host '[FAIL] dev instance did not report phase=ready.'
if ($state) {
  Write-Host ('       last phase: ' + $state.phase + '  pid: ' + $state.pid)
  foreach ($evt in $state.events) {
    Write-Host ('       event: ' + $evt.phase + ' ' + $evt.error)
  }
} else {
  Write-Host '       startup-state.json was not rewritten by a newer instance.'
}
if (Test-Path -LiteralPath $errFile) {
  Write-Host '       --- tail of startup-error.log ---'
  Get-Content -LiteralPath $errFile -Tail 20 | ForEach-Object { Write-Host ('       ' + $_) }
}
exit 2
