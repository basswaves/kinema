<#
.SYNOPSIS
  The per-user installer, end to end in Windows Sandbox: never on this PC.

.DESCRIPTION
  Installs, plays, offers as a video player and uninstalls Kinema in a
  throwaway Windows, and says what was left behind:

    1. Silent install (/S, as winget runs it) on a sandbox with no WebView2:
       the installer has to fetch Microsoft's runtime itself. Then what is in
       the install folder, the Start menu and Apps (the Uninstall key).
    2. Play: the installed Kinema started for a 12-second clip must reach the
       player and close by itself - which it cannot do unless both DLLs are
       where Windows looks for them.
    3. Offer as a video player (the Settings button's code, through a
       self-test plan), so the uninstaller has entries to take away.
    4. Silent uninstall: the library is kept (nobody was asked), everything
       else goes. Registry lines naming Kinema before install and after, and
       the folders.
    5. Install again, then uninstall through the uninstaller's own window with
       "Delete the application data" ticked (clicked by window messages
       inside the sandbox): the library goes too.

  Everything is written to the staging folder: result.txt, the logs, the
  registry exports. The sandbox window is moved off the primary screen as soon
  as it appears.

  Needs: Windows Sandbox switched on, the installer
  (src-tauri\target\release\bundle\nsis\*-setup.exe, from
  `scripts/build-app.ps1 -Installer` or
  `npx tauri build --config src-tauri/tauri.installer.conf.json`), and a
  short test clip (-Short, about 12 s, any video Kinema plays).

  This file is deliberately ASCII only; see build-app.ps1 for why.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Short,
    # An installer to test instead of the local build's: one from a draft release.
    [string]$Installer = '',
    [int]$TimeoutMinutes = 20
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$sandbox = Join-Path $env:WINDIR 'System32\WindowsSandbox.exe'
if (-not (Test-Path $sandbox)) {
    throw 'Windows Sandbox is not switched on (Windows Features -> Windows Sandbox).'
}
$setup = if ($Installer) { @(Get-Item $Installer) } else { @(Get-ChildItem (Join-Path $root 'src-tauri\target\release\bundle\nsis\*-setup.exe')) }
if ($setup.Count -ne 1) { throw 'Expected one installer in src-tauri\target\release\bundle\nsis.' }

$stage = Join-Path $env:TEMP ('kinema-sandbox-installer-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory $stage | Out-Null
Copy-Item $setup[0].FullName (Join-Path $stage 'setup.exe')
Copy-Item $Short (Join-Path $stage 'short.mkv')

$inside = 'C:\Users\WDAGUtilityAccount\Desktop\kinema'
@'
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here 'result.txt'
function Say($text) { Add-Content -Path $out -Value $text }
$installDir = Join-Path $env:LOCALAPPDATA 'Kinema'
$data = Join-Path $env:APPDATA 'com.kinema.app'
$webData = Join-Path $env:LOCALAPPDATA 'com.kinema.app'
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Kinema'
function Keep($name) {
    foreach ($log in 'app.log', 'mpv.log') {
        $from = Join-Path $data "logs\$log"
        if (Test-Path $from) { Copy-Item $from (Join-Path $here "$name-$log") -Force }
    }
}
function RegLines($file) {
    if (-not (Test-Path $file)) { return @() }
    $key = ''
    Get-Content $file | ForEach-Object {
        if ($_ -like '[[]*') { $key = $_ }
        if ($_ -match '(?i)kinema|basswaves') { "$key  $_" }
    } | Select-Object -Unique
}
function Places($label) {
    Say "$label"
    Say "  install folder: $(if (Test-Path $installDir) { (Get-ChildItem $installDir -Recurse -Name) -join ', ' } else { 'gone' })"
    Say "  library ($data): $(Test-Path $data); web data: $(Test-Path $webData)"
    $links = @(Get-ChildItem $startMenu -Recurse -Filter '*Kinema*' -ErrorAction SilentlyContinue) +
        @(Get-ChildItem ([Environment]::GetFolderPath('Desktop')) -Filter 'Kinema*.lnk' -ErrorAction SilentlyContinue)
    Say "  shortcuts: $(if ($links) { ($links.FullName) -join ', ' } else { 'none' })"
    Say "  Apps entry: $(Test-Path $uninstallKey)"
}
function WaitUninstalled {
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
        $busy = Get-Process | Where-Object { $_.ProcessName -match '^(Un|Un_\w*|Au_\w*|uninstall)$' }
        if (-not (Test-Path (Join-Path $installDir 'uninstall.exe')) -and -not $busy) { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Win {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc f, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    static string Text(IntPtr h) { var s = new StringBuilder(256); GetWindowText(h, s, 256); return s.ToString().Replace("&", ""); }
    // A control whose text contains `text`, or is exactly it when `exact`
    // (a button: "Uninstall" is also inside "will be uninstalled from").
    public static IntPtr Child(IntPtr parent, string text, bool exact = false) {
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(parent, (h, l) => {
            var t = Text(h);
            var hit = exact ? string.Equals(t, text, StringComparison.OrdinalIgnoreCase)
                            : t.IndexOf(text, StringComparison.OrdinalIgnoreCase) >= 0;
            if (hit) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    // The visible top-level windows of these processes, by title: the
    // uninstaller runs from a copy of itself in the temporary folder, under
    // another name, and its title is NSIS's, not one to guess.
    public static List<KeyValuePair<IntPtr, string>> WindowsOf(HashSet<uint> pids) {
        var list = new List<KeyValuePair<IntPtr, string>>();
        EnumWindows((h, l) => {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pids.Contains(pid) && IsWindowVisible(h)) list.Add(new KeyValuePair<IntPtr, string>(h, Text(h)));
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
"@
Say "started $(Get-Date -Format s)"
try {
    $ProgressPreference = 'SilentlyContinue'
    New-Item -ItemType Directory 'C:\Videos' | Out-Null
    Copy-Item (Join-Path $here 'short.mkv') 'C:\Videos\Short clip.mkv'
    Copy-Item (Join-Path $here 'setup.exe') (Join-Path $env:TEMP 'kinema-setup.exe')
    $setupExe = Join-Path $env:TEMP 'kinema-setup.exe'
    Say "WebView2 before install: $(Test-Path 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application')"
    & reg export HKCU\Software (Join-Path $here 'before.reg') /y | Out-Null

    # 1. Silent install.
    $t0 = Get-Date
    $p = Start-Process $setupExe -ArgumentList '/S' -PassThru -Wait
    Say "1 silent install: exit $($p.ExitCode) after $([int]((Get-Date) - $t0).TotalSeconds) s"
    Say "  WebView2 after install: $(Test-Path 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application')"
    Places '  after install:'
    $u = Get-ItemProperty $uninstallKey -ErrorAction SilentlyContinue
    if ($u) { Say "  Apps entry: $($u.DisplayName) $($u.DisplayVersion) by $($u.Publisher); uninstall: $($u.UninstallString)" }
    $exe = Get-ChildItem $installDir -Filter '*.exe' | Where-Object { $_.Name -ne 'uninstall.exe' } | Select-Object -First 1
    Say "  program: $($exe.FullName)"
    & reg export HKCU\Software (Join-Path $here 'installed.reg') /y | Out-Null

    # 2. Play.
    $t0 = Get-Date
    $p = Start-Process $exe.FullName -ArgumentList '"C:\Videos\Short clip.mkv"' -PassThru
    $closed = $p.WaitForExit(120000)
    Say "2 started for a video: closed by itself $closed after $([int]((Get-Date) - $t0).TotalSeconds) s"
    if (-not $closed) { Stop-Process -Id $p.Id -Force }
    Keep 'play'
    $mpvLog = Join-Path $here 'play-mpv.log'
    $played = (Test-Path $mpvLog) -and (Select-String -Path $mpvLog -Pattern 'Short clip' -SimpleMatch -Quiet)
    Say "  mpv opened the clip: $played"
    $appLog = Join-Path $here 'play-app.log'
    if (Test-Path $appLog) {
        Select-String -Path $appLog -Pattern 'opened:|first frame|libmpv|shown to the user' | Select-Object -First 6 | ForEach-Object { Say "  log: $($_.Line)" }
    }

    # 3. Offer as a video player.
    $dir = Join-Path $env:TEMP 'plan-offer'
    New-Item -ItemType Directory $dir -Force | Out-Null
    $plan = @{ path = 'C:\Videos\Short clip.mkv'; fileId = $null; titleId = $null; seconds = 10;
        actions = @(@{ at = 2; do = 'call'; fn = 'offerAsPlayer' }, @{ at = 5; do = 'call'; fn = 'playerOffer' }) }
    [System.IO.File]::WriteAllText((Join-Path $dir 'plan.json'), ($plan | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding $false))
    $env:KINEMA_SELFTEST = Join-Path $dir 'plan.json'
    $p = Start-Process $exe.FullName -PassThru
    Remove-Item Env:\KINEMA_SELFTEST
    $p.WaitForExit(40000) | Out-Null
    Get-Process SystemSettings -ErrorAction SilentlyContinue | Stop-Process -Force
    Say "3 offered: RegisteredApplications $([bool](Get-ItemProperty HKCU:\Software\RegisteredApplications -Name Kinema -ErrorAction SilentlyContinue)); command: $((Get-ItemProperty 'HKCU:\Software\Classes\Kinema.Video\shell\open\command' -ErrorAction SilentlyContinue).'(default)')"
    & reg export HKCU\Software (Join-Path $here 'offered.reg') /y | Out-Null
    Say "  ($((RegLines (Join-Path $here 'offered.reg')).Count) registry lines name Kinema while offered)"

    # 4. Silent uninstall.
    $p = Start-Process (Join-Path $installDir 'uninstall.exe') -ArgumentList '/S' -PassThru -Wait
    Say "4 silent uninstall: exit $($p.ExitCode), finished $(WaitUninstalled)"
    Places '  after silent uninstall:'
    & reg export HKCU\Software (Join-Path $here 'after.reg') /y | Out-Null
    $before = @(RegLines (Join-Path $here 'before.reg'))
    $after = @(RegLines (Join-Path $here 'after.reg'))
    Say "  registry lines naming Kinema: before install $($before.Count), after uninstall $($after.Count)"
    $after | Where-Object { $before -notcontains $_ } | ForEach-Object { Say "  left: $_" }

    # 5. Install again; uninstall through its window, library ticked.
    Start-Process $setupExe -ArgumentList '/S' -Wait
    $p = Start-Process $exe.FullName -ArgumentList '"C:\Videos\Short clip.mkv"' -PassThru
    if (-not $p.WaitForExit(120000)) { Stop-Process -Id $p.Id -Force }
    Say "5 installed again; library there: $(Test-Path (Join-Path $data 'library.db'))"
    Start-Process (Join-Path $installDir 'uninstall.exe')
    $window = [IntPtr]::Zero
    $box = [IntPtr]::Zero
    $seen = @{}
    foreach ($i in 1..40) {
        Start-Sleep -Seconds 1
        $pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
        Get-Process | Where-Object { $_.ProcessName -match '^(Un|Un_\w*|Au_\w*|uninstall)$' } | ForEach-Object { [void]$pids.Add([uint32]$_.Id) }
        foreach ($w in [Win]::WindowsOf($pids)) {
            if (-not $seen.ContainsKey($w.Value)) { $seen[$w.Value] = $true; Say "  uninstaller window seen: '$($w.Value)'" }
            $b = [Win]::Child($w.Key, 'application data')
            if ($b -ne [IntPtr]::Zero) { $window = $w.Key; $box = $b; break }
        }
        if ($box -ne [IntPtr]::Zero) { break }
    }
    Say "  uninstaller window: $($window -ne [IntPtr]::Zero); checkbox: $($box -ne [IntPtr]::Zero)"
    if ($box -ne [IntPtr]::Zero) {
        $sb = New-Object System.Text.StringBuilder 256; [Win]::GetWindowText($box, $sb, 256) | Out-Null
        Say "  checkbox reads: $sb; ticked at first: $([Win]::SendMessage($box, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero))"
        [Win]::SendMessage($box, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        Say "  ticked now: $([Win]::SendMessage($box, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero))"
        $go = [Win]::Child($window, 'Uninstall', $true)
        Say "  Uninstall button: $($go -ne [IntPtr]::Zero)"
        [Win]::SendMessage($go, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        # The last page waits for Finish or Close; pressed until the
        # uninstaller is gone.
        $deadline = (Get-Date).AddSeconds(120)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 2
            $pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
            Get-Process | Where-Object { $_.ProcessName -match '^(Un|Un_\w*|Au_\w*|uninstall)$' } | ForEach-Object { [void]$pids.Add([uint32]$_.Id) }
            if ($pids.Count -eq 0) { break }
            foreach ($w in [Win]::WindowsOf($pids)) {
                foreach ($label in 'Finish', 'Close') {
                    $btn = [Win]::Child($w.Key, $label, $true)
                    if ($btn -ne [IntPtr]::Zero) { [Win]::SendMessage($btn, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
                }
            }
        }
        Say "  uninstall finished: $(WaitUninstalled)"
    }
    Places '  after uninstall with the library ticked:'
    & reg export HKCU\Software (Join-Path $here 'after-all.reg') /y | Out-Null
    $afterAll = @(RegLines (Join-Path $here 'after-all.reg'))
    Say "  registry lines naming Kinema: $($afterAll.Count)"
    $afterAll | Where-Object { $before -notcontains $_ } | ForEach-Object { Say "  left: $_" }
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
    # The sandbox may be writing the file at that moment: a read it refuses
    # is not the end, only a try for the next round.
    $done = try { (Test-Path $result) -and (Select-String -Path $result -Pattern '^DONE$' -Quiet -ErrorAction Stop) } catch { $false }
    if ($done) { break }
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
