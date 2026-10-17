<#
.SYNOPSIS
  Kinema as a video player, end to end in Windows Sandbox: never on this PC.

.DESCRIPTION
  Runs the release build in a throwaway Windows and checks what opening a
  video from outside does (opened.rs, default_player.rs):

    A. Started for a video (twice: the first start of a fresh Windows, then
       again): straight to the player, and Kinema closes by itself when the
       12-second clip ends. app.log says how long from start to first frame.
    B. A Kinema already running is handed a video by a second one started for
       it: the second ends at once and the first plays the video.
    C. Offer as a video player (the Settings button's own code, through a
       self-test plan): the registry entries, a screenshot of the sandbox's
       screen with Default apps open, and Kinema started through the command
       it registered, as a double-click with Kinema chosen would.
    D. Remove: every entry gone. Every line of the account's registry that
       names Kinema before and after is written out to compare.

  Everything is written to the staging folder: result.txt, the logs,
  screenshot.png. The sandbox window is moved off the primary screen as soon
  as it appears. A clean sandbox has no WebView2: the script installs
  Microsoft's runtime inside it (the owner allowed that, 2026-10-17); it is
  gone when the sandbox closes.

  Needs: Windows Sandbox switched on, a release build
  (src-tauri\target\release\kinema.exe, e.g. `npx tauri build`), and two test
  clips: -Short (about 12 s) and -Long (over a minute), any video Kinema plays.

  This file is deliberately ASCII only; see build-app.ps1 for why.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Short,
    [Parameter(Mandatory = $true)][string]$Long,
    [int]$TimeoutMinutes = 20
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$sandbox = Join-Path $env:WINDIR 'System32\WindowsSandbox.exe'
if (-not (Test-Path $sandbox)) {
    throw 'Windows Sandbox is not switched on (Windows Features -> Windows Sandbox).'
}
$exe = Join-Path $root 'src-tauri\target\release\kinema.exe'
if (-not (Test-Path $exe)) { throw 'No release build: run npx tauri build first.' }

$stage = Join-Path $env:TEMP ('kinema-sandbox-player-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$app = Join-Path $stage 'app'
New-Item -ItemType Directory $app | Out-Null
Copy-Item $exe $app
foreach ($dll in 'libmpv-2.dll', 'libmpv-wrapper.dll') {
    Copy-Item (Join-Path $root "src-tauri\lib\$dll") $app
}
# No VCRUNTIME140.dll copied in: a clean sandbox lacking it is the point. The
# wrapper from scripts/build-mpv-wrapper.sh has its runtime built in; the
# plugin's own wrapper does not, and fails to load here (error 126).
Copy-Item $Short (Join-Path $stage 'short.mkv')
Copy-Item $Long (Join-Path $stage 'long.mkv')

$inside = 'C:\Users\WDAGUtilityAccount\Desktop\kinema'
@'
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here 'result.txt'
function Say($text) { Add-Content -Path $out -Value $text }
$logs = Join-Path $env:APPDATA 'com.kinema.app\logs'
function Keep($name) {
    foreach ($log in 'app.log', 'mpv.log') {
        $from = Join-Path $logs $log
        if (Test-Path $from) { Copy-Item $from (Join-Path $here "$name-$log") -Force }
    }
}
function KinemaLines($name) {
    $file = Join-Path $here "$name-app.log"
    if (Test-Path $file) { Select-String -Path $file -Pattern 'opened:|default player:|a second Kinema' | ForEach-Object { Say "  log: $($_.Line)" } }
}
function SelfTest($name, $actions, $seconds) {
    $dir = Join-Path $env:TEMP "plan-$name"
    New-Item -ItemType Directory $dir -Force | Out-Null
    $plan = @{ path = 'C:\Videos\Short clip.mkv'; fileId = $null; titleId = $null; seconds = $seconds; actions = $actions }
    # Without a byte-order mark, which Windows PowerShell's UTF8 adds and
    # Kinema's plan reader refuses (the page then opens Home instead).
    [System.IO.File]::WriteAllText((Join-Path $dir 'plan.json'), ($plan | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding $false))
    $env:KINEMA_SELFTEST = Join-Path $dir 'plan.json'
    $p = Start-Process 'C:\Kinema\kinema.exe' -PassThru
    Remove-Item Env:\KINEMA_SELFTEST
    return @{ process = $p; report = (Join-Path $dir 'report.json') }
}
function RegLines($file) {
    if (-not (Test-Path $file)) { return @() }
    $key = ''
    Get-Content $file | ForEach-Object {
        if ($_ -like '[[]*') { $key = $_ }
        if ($_ -match '(?i)kinema') { "$key  $_" }
    } | Select-Object -Unique
}
Say "started $(Get-Date -Format s)"
try {
    $ProgressPreference = 'SilentlyContinue'
    # WebView2, which a clean sandbox does not have.
    $setup = Join-Path $env:TEMP 'webview2.exe'
    Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $setup -UseBasicParsing
    Start-Process $setup -ArgumentList '/silent', '/install' -Wait
    Say "WebView2 installed: $(Test-Path 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application')"

    # Kinema and the clips on the sandbox's own disk (SQLite on a mapped
    # folder fails, and a ZIP's folder is somewhere like this).
    Copy-Item (Join-Path $here 'app') 'C:\Kinema' -Recurse
    New-Item -ItemType Directory 'C:\Videos' | Out-Null
    Copy-Item (Join-Path $here 'short.mkv') 'C:\Videos\Short clip.mkv'
    Copy-Item (Join-Path $here 'long.mkv') 'C:\Videos\Holiday clip.mkv'
    & reg export HKCU\Software (Join-Path $here 'before.reg') /y | Out-Null

    # A. Started for a video, twice.
    foreach ($round in 1, 2) {
        $t0 = Get-Date
        $p = Start-Process 'C:\Kinema\kinema.exe' -ArgumentList '"C:\Videos\Short clip.mkv"' -PassThru
        $closed = $p.WaitForExit(90000)
        Say "A$round started for a video: closed by itself $closed after $([int]((Get-Date) - $t0).TotalSeconds) s"
        if (-not $closed) { Stop-Process -Id $p.Id -Force }
        Keep "A$round"; KinemaLines "A$round"
    }

    # B. A running Kinema is handed a video.
    $first = Start-Process 'C:\Kinema\kinema.exe' -PassThru
    Start-Sleep -Seconds 10
    $second = Start-Process 'C:\Kinema\kinema.exe' -ArgumentList '"C:\Videos\Holiday clip.mkv"' -PassThru
    $secondEnded = $second.WaitForExit(15000)
    Start-Sleep -Seconds 8
    Say "B second Kinema ended at once: $secondEnded; first still running: $(-not $first.HasExited)"
    Keep 'B'; KinemaLines 'B'
    $loaded = Select-String -Path (Join-Path $here 'B-mpv.log') -Pattern 'Holiday clip' -SimpleMatch | Select-Object -First 1
    Say "B mpv opened the handed-over video: $([bool]$loaded)"
    Stop-Process -Id $first.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    # C. Offer as a video player, as the Settings button does.
    $run = SelfTest 'offer' @(
        @{ at = 2; do = 'call'; fn = 'offerAsPlayer' },
        @{ at = 5; do = 'call'; fn = 'playerOffer' }
    ) 14
    Start-Sleep -Seconds 10
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    [System.Drawing.Graphics]::FromImage($bitmap).CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save((Join-Path $here 'screenshot.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    $run.process.WaitForExit(30000) | Out-Null
    if (Test-Path $run.report) {
        Select-String -Path $run.report -Pattern 'call:done|call:failed' | ForEach-Object { Say "  C report: $($_.Line.Trim())" }
        Copy-Item $run.report (Join-Path $here 'C-report.json')
    }
    Say "C RegisteredApplications: $((& reg query HKCU\Software\RegisteredApplications /v Kinema 2>&1) -join ' ')"
    Say "C .mkv OpenWithProgids: $((& reg query HKCU\Software\Classes\.mkv\OpenWithProgids 2>&1) -join ' ')"
    $command = (Get-ItemProperty 'HKCU:\Software\Classes\Kinema.Video\shell\open\command' -ErrorAction SilentlyContinue).'(default)'
    Say "C command: $command"
    & reg export HKCU\Software (Join-Path $here 'offered.reg') /y | Out-Null
    Get-Process SystemSettings -ErrorAction SilentlyContinue | Stop-Process -Force
    if ($command) {
        $line = $command.Replace('%1', 'C:\Videos\Short clip.mkv')
        $t0 = Get-Date
        $p = Start-Process 'cmd.exe' -ArgumentList '/c', "`"$line`"" -PassThru -WindowStyle Hidden
        Start-Sleep -Seconds 2
        $k = Get-Process kinema -ErrorAction SilentlyContinue | Select-Object -First 1
        $closed = if ($k) { $k.WaitForExit(90000) } else { $false }
        Say "C started through the registered command: closed by itself $closed after $([int]((Get-Date) - $t0).TotalSeconds) s"
        Keep 'C'; KinemaLines 'C'
    }

    # D. Remove.
    $run = SelfTest 'remove' @(
        @{ at = 2; do = 'call'; fn = 'removeAsPlayer' },
        @{ at = 4; do = 'call'; fn = 'playerOffer' }
    ) 7
    $run.process.WaitForExit(30000) | Out-Null
    if (Test-Path $run.report) {
        Select-String -Path $run.report -Pattern 'call:done|call:failed' | ForEach-Object { Say "  D report: $($_.Line.Trim())" }
    }
    & reg export HKCU\Software (Join-Path $here 'after.reg') /y | Out-Null
    Say 'Registry lines naming Kinema, before the offer:'
    RegLines (Join-Path $here 'before.reg') | ForEach-Object { Say "  $_" }
    Say 'Registry lines naming Kinema, while offered:'
    RegLines (Join-Path $here 'offered.reg') | Select-Object -First 12 | ForEach-Object { Say "  $_" }
    Say "  ($((RegLines (Join-Path $here 'offered.reg')).Count) lines in all)"
    Say 'Registry lines naming Kinema, after Remove:'
    RegLines (Join-Path $here 'after.reg') | ForEach-Object { Say "  $_" }
} catch {
    Say "script failed: $_"
}
Say 'DONE'
'@ | Set-Content -Path (Join-Path $stage 'inner.ps1') -Encoding UTF8

$wsb = Join-Path $stage 'kinema.wsb'
@"
<Configuration>
  <Networking>Enable</Networking>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$stage</HostFolder>
      <SandboxFolder>$inside</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File $inside\inner.ps1</Command>
  </LogonCommand>
</Configuration>
"@ | Set-Content -Path $wsb -Encoding UTF8

# The sandbox's window, off the primary screen the owner works on.
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SandboxWindow {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags);
}
'@
$other = [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Select-Object -First 1
function Move-Sandbox {
    if (-not $other) { return }
    $handle = [SandboxWindow]::FindWindow('WindowsSandboxRemoteSession', $null)
    if ($handle -eq [IntPtr]::Zero) {
        $p = Get-Process WindowsSandboxRemoteSession, WindowsSandboxClient -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
        if ($p) { $handle = $p.MainWindowHandle }
    }
    if ($handle -ne [IntPtr]::Zero) {
        $a = $other.WorkingArea
        [SandboxWindow]::SetWindowPos($handle, [IntPtr]::Zero, $a.X + 20, $a.Y + 20, [Math]::Min(1600, $a.Width - 40), [Math]::Min(900, $a.Height - 40), 0x0014) | Out-Null
    }
}

Write-Host "Starting Windows Sandbox (staging: $stage)"
Start-Process $sandbox -ArgumentList "`"$wsb`""
foreach ($wait in 4, 4, 8, 8, 15) { Start-Sleep -Seconds $wait; Move-Sandbox }

$result = Join-Path $stage 'result.txt'
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
while ((Get-Date) -lt $deadline) {
    if ((Test-Path $result) -and (Select-String -Path $result -Pattern '^DONE$' -Quiet)) { break }
    Start-Sleep -Seconds 10
    Move-Sandbox
}
if (Test-Path $result) { Get-Content $result } else { Write-Host 'No result was written.' }
if (Get-Command wsb -ErrorAction SilentlyContinue) {
    $running = (wsb list --raw | ConvertFrom-Json).WindowsSandboxEnvironments
    foreach ($box in $running) { wsb stop --id $(if ($box.Id) { $box.Id } else { $box }) | Out-Null }
}
Get-Process WindowsSandbox, WindowsSandboxClient, WindowsSandboxRemoteSession -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host "Result kept in $result"
