<#
.SYNOPSIS
  The real one-press ffmpeg install, in Windows Sandbox: never on this PC.

.DESCRIPTION
  Runs Kinema's own install code (ffmpeg_install.rs, the ignored test
  `a_real_winget_install`) in a throwaway Windows, so winget really installs
  Gyan.FFmpeg.Essentials and the test checks that a process started before
  the install finds ffmpeg and ffprobe without a restart, that the build
  decodes every format Kinema needs, and that a second press is "already
  installed".

  Windows Sandbox has no winget, so the script inside installs Windows' App
  Installer first (from Microsoft's own links), then runs the test. Everything
  it downloads stays in the sandbox and is gone when its window closes.

  Needs: Windows Sandbox switched on (Windows Features), and the test binary
  built (`cargo test --manifest-path src-tauri/Cargo.toml --no-run`). The
  sandbox opens a window of its own; nothing here touches the mouse or the
  keyboard. The result is written to the staging folder's result.txt and
  printed; the sandbox is closed at the end.
#>
[CmdletBinding()]
param(
    [int]$TimeoutMinutes = 20
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$sandbox = Join-Path $env:WINDIR 'System32\WindowsSandbox.exe'
if (-not (Test-Path $sandbox)) {
    throw 'Windows Sandbox is not switched on (Windows Features -> Windows Sandbox).'
}

$test = Get-ChildItem (Join-Path $root 'src-tauri\target\debug\deps') -Filter 'kinema_lib-*.exe' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $test) { throw 'No test binary: run cargo test --no-run first.' }

# A folder of this run's own: a sandbox still closing keeps the last one open.
$stage = Join-Path $env:TEMP ('kinema-sandbox-ffmpeg-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory $stage | Out-Null
Copy-Item $test.FullName (Join-Path $stage 'kinema-tests.exe')
# Rust's MSVC runtime: part of the host's System32 from other programs, not
# of the sandbox's clean Windows.
foreach ($dll in 'vcruntime140.dll', 'vcruntime140_1.dll') {
    $from = Join-Path $env:WINDIR "System32\$dll"
    if (Test-Path $from) { Copy-Item $from $stage }
}

$inside = 'C:\Users\WDAGUtilityAccount\Desktop\kinema'
@'
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here 'result.txt'
function Say($text) { Add-Content -Path $out -Value $text }
Say "started $(Get-Date -Format s)"
try {
    $ProgressPreference = 'SilentlyContinue'
    $dl = Join-Path $env:TEMP 'appinstaller'
    New-Item -ItemType Directory $dl -Force | Out-Null
    # winget's own release publishes the packages it needs beside it; the
    # set changes between versions, so it is taken from there, not listed.
    $release = 'https://github.com/microsoft/winget-cli/releases/latest/download'
    $files = [ordered]@{
        'deps.zip'          = "$release/DesktopAppInstaller_Dependencies.zip"
        'winget.msixbundle' = "$release/Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.msixbundle"
    }
    foreach ($name in $files.Keys) {
        Invoke-WebRequest -Uri $files[$name] -OutFile (Join-Path $dl $name) -UseBasicParsing
        Say "downloaded $name"
    }
    Expand-Archive (Join-Path $dl 'deps.zip') (Join-Path $dl 'deps') -Force
    $deps = Get-ChildItem (Join-Path $dl 'deps') -Recurse -Include *.appx, *.msix |
        Where-Object { $_.FullName -match 'x64' }
    foreach ($dep in $deps) {
        try { Add-AppxPackage $dep.FullName -ErrorAction Stop; Say "added $($dep.Name)" }
        catch { Say "could not add $($dep.Name): $_" }
    }
    try { Add-AppxPackage (Join-Path $dl 'winget.msixbundle') -ErrorAction Stop; Say 'added App Installer' }
    catch { Say "could not add App Installer: $_" }
    # The alias appears a moment after the package, in a folder this
    # session's PATH may not have had at logon.
    $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'
    if (($env:Path -split ';') -notcontains $alias) { $env:Path += ";$alias" }
    for ($i = 0; $i -lt 30 -and -not (Get-Command winget -ErrorAction SilentlyContinue); $i++) {
        Start-Sleep -Seconds 2
    }
    Say "App Installer: $((Get-AppxPackage Microsoft.DesktopAppInstaller).Version)"
    Say "winget $(& winget --version 2>&1)"
    # The process below starts with this PATH, which has no ffmpeg: as a
    # Kinema running before the install would.
    Say "ffmpeg on PATH before: $([bool](Get-Command ffmpeg -ErrorAction SilentlyContinue))"
    $log = & (Join-Path $here 'kinema-tests.exe') ffmpeg_install::tests::a_real_winget_install --ignored --nocapture --test-threads=1 2>&1
    Say ($log -join "`n")
    Say "exit $LASTEXITCODE"
    Say ((& winget list --id Gyan.FFmpeg.Essentials --accept-source-agreements 2>&1) -join "`n")
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

Write-Host "Starting Windows Sandbox (staging: $stage)"
Start-Process $sandbox -ArgumentList "`"$wsb`""

$result = Join-Path $stage 'result.txt'
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
while ((Get-Date) -lt $deadline) {
    if ((Test-Path $result) -and (Select-String -Path $result -Pattern '^DONE$' -Quiet)) { break }
    Start-Sleep -Seconds 10
}
if (Test-Path $result) { Get-Content $result } else { Write-Host 'No result was written.' }
# Closed with Windows' own sandbox tool where there is one (Windows 11 24H2
# and later); its window alone, otherwise.
if (Get-Command wsb -ErrorAction SilentlyContinue) {
    $running = (wsb list --raw | ConvertFrom-Json).WindowsSandboxEnvironments
    foreach ($box in $running) { wsb stop --id $(if ($box.Id) { $box.Id } else { $box }) | Out-Null }
}
Get-Process WindowsSandbox, WindowsSandboxClient -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host "Result kept in $result"
if (-not ((Test-Path $result) -and (Select-String -Path $result -Pattern '^exit 0$' -Quiet))) { exit 1 }
