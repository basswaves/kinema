<#
.SYNOPSIS
  A newer setup run by hand updates Kinema in place: in Windows Sandbox,
  never on this PC.

.DESCRIPTION
  Installs the previous release (-Previous, silently, as winget would), makes
  what an owner would have by then - the Start menu and desktop shortcuts, a
  copy of the shortcut among the taskbar's pinned items, the default-player
  registration - then runs the new setup with no arguments, as a double click
  does, and says what survived: the same shortcut files (same creation time,
  so not deleted and recreated), the pinned copy, the registration, the new
  version in Apps. Last it uninstalls and says what is left.

  Needs: Windows Sandbox switched on, the new setup
  (src-tauri\target\release\bundle\nsis\*-setup.exe) and the previous release's
  setup (-Previous, from the project's GitHub releases), and a short clip.
  Results go to the staging folder's result.txt. ASCII only.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Previous,
    [Parameter(Mandatory = $true)][string]$Short,
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

$stage = Join-Path $env:TEMP ('kinema-sandbox-update-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory $stage | Out-Null
Copy-Item $setup[0].FullName (Join-Path $stage 'setup.exe')
Copy-Item $Previous (Join-Path $stage 'previous.exe')
Copy-Item $Short (Join-Path $stage 'short.mkv')

$inside = 'C:\Users\WDAGUtilityAccount\Desktop\kinema'
@'
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here 'result.txt'
function Say($text) { Add-Content -Path $out -Value $text }
$installDir = Join-Path $env:LOCALAPPDATA 'Kinema'
$startLnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Kinema.lnk'
$deskLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Kinema.lnk'
$pinDir = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
$pinLnk = Join-Path $pinDir 'Kinema.lnk'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Kinema'
function Stamp($f) { if (Test-Path $f) { (Get-Item $f).CreationTimeUtc.Ticks } else { 'missing' } }
function RegLines($file) {
    if (-not (Test-Path $file)) { return @() }
    $key = ''
    Get-Content $file | ForEach-Object {
        if ($_ -like '[[]*') { $key = $_ }
        if ($_ -match '(?i)kinema|basswaves') { "$key  $_" }
    } | Select-Object -Unique
}
function State($label) {
    Say $label
    Say "  version in Apps: $((Get-ItemProperty $uninstallKey -ErrorAction SilentlyContinue).DisplayVersion); program file version: $((Get-Item (Join-Path $installDir 'kinema.exe') -ErrorAction SilentlyContinue).VersionInfo.FileVersion)"
    Say "  start menu shortcut: $(Stamp $startLnk); desktop: $(Stamp $deskLnk); pinned copy: $(Stamp $pinLnk)"
    Say "  default-player registration: RegisteredApplications $([bool](Get-ItemProperty HKCU:\Software\RegisteredApplications -Name Kinema -ErrorAction SilentlyContinue)); Kinema.Video $(Test-Path 'HKCU:\Software\Classes\Kinema.Video')"
}
function WaitIdle {
    $deadline = (Get-Date).AddSeconds(180)
    Start-Sleep -Seconds 5
    while ((Get-Date) -lt $deadline) {
        $busy = Get-Process | Where-Object { $_.ProcessName -match '^(kinema-setup|setup|previous|Un|Un_\w*|Au_\w*|uninstall)$' }
        if (-not $busy) { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}
Say "started $(Get-Date -Format s)"
try {
    $ProgressPreference = 'SilentlyContinue'
    New-Item -ItemType Directory 'C:\Videos' | Out-Null
    Copy-Item (Join-Path $here 'short.mkv') 'C:\Videos\Short clip.mkv'
    & reg export HKCU\Software (Join-Path $here 'before.reg') /y | Out-Null

    # 1. The previous release, installed silently.
    $p = Start-Process (Join-Path $here 'previous.exe') -ArgumentList '/S' -PassThru -Wait
    Say "1 previous release installed: exit $($p.ExitCode)"
    $exe = Join-Path $installDir 'kinema.exe'

    # 2. What an owner has by then.
    if (-not (Test-Path $startLnk)) { Copy-Item $deskLnk $startLnk -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory $pinDir -Force | Out-Null
    Copy-Item $startLnk $pinLnk -Force
    $dir = Join-Path $env:TEMP 'plan-offer'
    New-Item -ItemType Directory $dir -Force | Out-Null
    $plan = @{ path = 'C:\Videos\Short clip.mkv'; fileId = $null; titleId = $null; seconds = 10;
        actions = @(@{ at = 2; do = 'call'; fn = 'offerAsPlayer' }, @{ at = 5; do = 'call'; fn = 'playerOffer' }) }
    [System.IO.File]::WriteAllText((Join-Path $dir 'plan.json'), ($plan | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding $false))
    $env:KINEMA_SELFTEST = Join-Path $dir 'plan.json'
    $p = Start-Process $exe -PassThru
    Remove-Item Env:\KINEMA_SELFTEST
    $p.WaitForExit(60000) | Out-Null
    Get-Process SystemSettings -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process kinema -ErrorAction SilentlyContinue | Stop-Process -Force
    State '2 before the update:'
    $stamps = @{ s = Stamp $startLnk; d = Stamp $deskLnk; p = Stamp $pinLnk }

    # 3. The new setup, no arguments: a double click.
    $t0 = Get-Date
    Start-Process (Join-Path $here 'setup.exe') | Out-Null
    Say "3 new setup started with defaults; finished $(WaitIdle) after $([int]((Get-Date) - $t0).TotalSeconds) s"
    Start-Sleep -Seconds 10
    Say "  Kinema started at the end: $([bool](Get-Process kinema -ErrorAction SilentlyContinue))"
    Get-Process kinema -ErrorAction SilentlyContinue | Stop-Process -Force
    State '  after the update:'
    Say "  same files, not recreated: start $((Stamp $startLnk) -eq $stamps.s); desktop $((Stamp $deskLnk) -eq $stamps.d); pinned copy $((Stamp $pinLnk) -eq $stamps.p)"
    & reg export HKCU\Software (Join-Path $here 'updated.reg') /y | Out-Null

    # 4. A real uninstall leaves nothing.
    $p = Start-Process (Join-Path $installDir 'uninstall.exe') -ArgumentList '/S' -PassThru -Wait
    Say "4 silent uninstall: exit $($p.ExitCode), finished $(WaitIdle)"
    State '  after uninstall:'
    Say "  install folder there: $(Test-Path $installDir)"
    & reg export HKCU\Software (Join-Path $here 'after.reg') /y | Out-Null
    $before = @(RegLines (Join-Path $here 'before.reg'))
    $after = @(RegLines (Join-Path $here 'after.reg'))
    Say "  registry lines naming Kinema: before $($before.Count), after uninstall $($after.Count)"
    $after | Where-Object { $before -notcontains $_ } | ForEach-Object { Say "  left: $_" }
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
