# Collects the evidence needed to attribute "the window put itself in the
# background" on a machine where Mineradio is running. Read-only: it never
# touches the window, the settings or the audio session, and it writes exactly
# one report file to the Desktop.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\collect-window-report.ps1
#
[CmdletBinding()]
param(
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrWhiteSpace($OutFile)) {
  $OutFile = Join-Path ([Environment]::GetFolderPath('Desktop')) ('mineradio-window-report-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
}

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class MRWindowReport {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder t, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder t, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<string> Rows = new List<string>();
  public static HashSet<uint> Wanted = new HashSet<uint>();
  public static IntPtr Fg = IntPtr.Zero;
  static EnumProc _cb;
  public static void Run() {
    Rows.Clear();
    _cb = delegate (IntPtr h, IntPtr l) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!Wanted.Contains(pid)) return true;
      StringBuilder t = new StringBuilder(256); GetWindowTextW(h, t, t.Capacity);
      StringBuilder c = new StringBuilder(128); GetClassName(h, c, c.Capacity);
      RECT r; GetWindowRect(h, out r);
      int w = r.Right - r.Left; int hh = r.Bottom - r.Top;
      if (w <= 0 && hh <= 0 && c.ToString().StartsWith("Chrome_WidgetWin_")) return true;
      Rows.Add(string.Format("pid={0} iconic={1} visible={2} foreground={3} size={4}x{5} class={6} title=[{7}]",
        pid, IsIconic(h), IsWindowVisible(h), (h == Fg), w, hh, c.ToString(), t.ToString()));
      return true;
    };
    EnumWindows(_cb, IntPtr.Zero);
  }
}
"@

$out = New-Object System.Collections.Generic.List[string]
function Add-Line([string]$text) { $out.Add($text) }

Add-Line ("> mineradio window report")
Add-Line ("time=" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "  host=" + $env:COMPUTERNAME + "  user=" + $env:USERNAME)
Add-Line ("os=" + (Get-CimInstance Win32_OperatingSystem).Caption)

# ---------------------------------------------------------------- app process
$procs = @(Get-Process | Where-Object { $_.ProcessName -match '^(electron|Mineradio)$' })
if ($procs.Count -eq 0) {
  Add-Line 'APP-PROCESS=none (Mineradio is not running right now)'
} else {
  $exePaths = @{}
  foreach ($p in $procs) {
    [void][MRWindowReport]::Wanted.Add([uint32]$p.Id)
    $path = ''
    try { $path = $p.Path } catch { }
    if ($path -and -not $exePaths.ContainsKey($path)) { $exePaths[$path] = $true }
    Add-Line ("pid={0} name={1} wsMB={2} start={3}" -f $p.Id, $p.ProcessName, `
      [math]::Round($p.WorkingSet64 / 1MB), $p.StartTime.ToString('HH:mm:ss'))
  }
  foreach ($k in $exePaths.Keys) {
    $v = ''
    try { $v = (Get-Item -LiteralPath $k).VersionInfo.ProductVersion } catch { }
    Add-Line ("exe=" + $k + " productVersion=" + $v)
  }
  [MRWindowReport]::Fg = [MRWindowReport]::GetForegroundWindow()
  [MRWindowReport]::Run()
  Add-Line ''
  Add-Line '> top-level windows owned by the app'
  if ([MRWindowReport]::Rows.Count -eq 0) { Add-Line 'NO-TOP-LEVEL-WINDOWS' }
  foreach ($row in [MRWindowReport]::Rows) { Add-Line ('  ' + $row) }
}

# ------------------------------------------------------------ app state files
$ud = Join-Path $env:APPDATA 'Mineradio'
Add-Line ''
Add-Line ('> userData=' + $ud)

$stateFile = Join-Path $ud 'startup-state.json'
if (Test-Path -LiteralPath $stateFile) {
  Add-Line ('state-file-mtime=' + (Get-Item -LiteralPath $stateFile).LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
  try {
    $state = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    Add-Line ('  pid=' + $state.pid + ' phase=' + $state.phase + ' startedAt=' `
      + ([DateTimeOffset]::FromUnixTimeMilliseconds([double]$state.startedAt)).LocalDateTime.ToString('yyyy-MM-dd HH:mm:ss'))
    foreach ($e in @($state.events)) {
      $when = ([DateTimeOffset]::FromUnixTimeMilliseconds([double]$e.at)).LocalDateTime.ToString('yyyy-MM-dd HH:mm:ss')
      $kv = @()
      foreach ($prop in $e.PSObject.Properties) {
        if ($prop.Name -eq 'phase' -or $prop.Name -eq 'at') { continue }
        $kv += ($prop.Name + '=' + $prop.Value)
      }
      Add-Line ('  evt ' + $e.phase + ' @ ' + $when + ' :: ' + ($kv -join ' '))
    }
    if (@($state.events).Count -ge 32) { Add-Line '  NOTE events are capped at 32; older ones are gone' }
  } catch { Add-Line ('  startup-state.json parse failed: ' + $_.Exception.Message) }
} else {
  Add-Line '  startup-state.json MISSING'
}

$errFile = Join-Path $ud 'startup-error.log'
if (Test-Path -LiteralPath $errFile) {
  Add-Line ''
  Add-Line '> startup-error.log (last 40 lines)'
  Get-Content -LiteralPath $errFile -Encoding UTF8 -Tail 40 | ForEach-Object { Add-Line ('  ' + $_) }
} else {
  Add-Line '  startup-error.log absent (no startup failure was recorded)'
}

$fxFile = Join-Path $ud 'current-fx-autosave.json'
if (Test-Path -LiteralPath $fxFile) {
  try {
    $fx = Get-Content -LiteralPath $fxFile -Raw -Encoding UTF8 | ConvertFrom-Json
    Add-Line ''
    Add-Line '> fx settings that change background behaviour'
    foreach ($k in @('preset', 'wallpaperMode', 'desktopLyrics', 'performanceBackground', 'liveBackgroundKeep',
      'performanceQuality', 'foregroundFpsMode', 'memoryAutoTrimApp', 'memoryAutoTrimOnBackground',
      'memoryAutoSystemTrim', 'memorySystemIntervalMin', 'memorySystemThresholdPercent', 'memorySystemAutoElevate')) {
      Add-Line ('  ' + $k + '=' + $fx.$k)
    }
  } catch { Add-Line ('  current-fx-autosave.json parse failed: ' + $_.Exception.Message) }
}

# ------------------------------------------------------------- windows memory
Add-Line ''
Add-Line '> system memory'
$os = Get-CimInstance Win32_OperatingSystem
$totalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
$freeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
Add-Line ("  physical totalGB={0} freeGB={1} usedPct={2}" -f $totalGB, $freeGB, [math]::Round((1 - $freeGB / $totalGB) * 100))
Add-Line ("  commit totalGB={0} freeGB={1}" -f `
  [math]::Round($os.TotalVirtualMemorySize / 1MB, 2), [math]::Round($os.FreeVirtualMemory / 1MB, 2))

Add-Line ''
Add-Line '> memory exhaustion / resource diagnostics (System log, 72h)'
try {
  $since = (Get-Date).AddHours(-72)
  $ev = Get-WinEvent -FilterHashtable @{ LogName = 'System'; StartTime = $since; ProviderName = 'Microsoft-Windows-Resource-Exhaustion-Diagnoser' } -ErrorAction Stop
  foreach ($e in @($ev | Select-Object -First 6)) {
    Add-Line ('  ' + $e.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss') + ' id=' + $e.Id)
    Add-Line ('    ' + (($e.Message -split "`r?`n") -join ' / ').Substring(0, [Math]::Min(400, ($e.Message -replace "`r?`n", ' / ').Length)))
  }
  if (@($ev).Count -eq 0) { Add-Line '  none' }
} catch { Add-Line '  none recorded (provider empty or unavailable)' }

Add-Line ''
Add-Line '> app crash / hang entries (Application log, 72h)'
try {
  $since = (Get-Date).AddHours(-72)
  $ev = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $since; Level = 1, 2, 3 } -ErrorAction Stop
  $hits = @($ev | Where-Object { $_.ProviderName -match 'Application Error|Application Hang|Windows Error Reporting|\.NET Runtime' } | Select-Object -First 15)
  if ($hits.Count -eq 0) { Add-Line '  none' }
  foreach ($e in $hits) {
    $msg = ($e.Message -replace "`r?`n", ' / ')
    $keep = ''
    if ($msg.Length -gt 300) { $keep = $msg.Substring(0, 300) } else { $keep = $msg }
    Add-Line ('  ' + $e.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss') + ' [' + $e.ProviderName + '] id=' + $e.Id + ' ' + $keep)
  }
} catch { Add-Line '  none readable (query failed)' }

Set-Content -LiteralPath $OutFile -Value $out -Encoding UTF8
Write-Output ('REPORT=' + $OutFile)
Get-Content -LiteralPath $OutFile | Select-Object -First 60
