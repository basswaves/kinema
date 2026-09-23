<#
.SYNOPSIS
  Build the portable app and put a shortcut to it on the desktop.

.DESCRIPTION
  Produces `dist-app/` - a self-contained folder holding the release exe and the
  two native playback libraries - and refreshes a desktop shortcut pointing at
  it. Run it again after any change; it overwrites in place, so the shortcut
  never goes stale.

  Deliberately NOT an installer. `--no-bundle` skips the MSI and NSIS targets,
  which need extra toolchains downloaded on first use and would mean
  reinstalling on every rebuild. A folder and a shortcut have neither cost.

  Both DLLs are copied *beside* the exe rather than into `lib/`. The plugin
  looks in both places for `libmpv-wrapper.dll`, but `libmpv-2.dll` is resolved
  by Windows' own search order, which begins at the EXECUTABLE's directory and
  never looks in the directory the wrapper was loaded from. Splitting them loads
  the wrapper and then fails to find mpv.

  The shortcut still sets its working directory to the app folder. The logs no
  longer depend on it - they go to app data\logs - but a predictable working
  directory costs nothing and keeps anything else relative well behaved.

  This file is deliberately ASCII only. `powershell.exe` reads a .ps1 with no
  BOM as ANSI, so a stray em dash in a comment becomes a parse error in code
  three lines away - which is exactly as confusing as it sounds.
#>
[CmdletBinding()]
param(
    # Skip the desktop shortcut. Set automatically on CI, where there is no
    # desktop to put one on and the build only wants the portable folder.
    [switch]$NoShortcut
)

$ErrorActionPreference = 'Stop'

$onCI = [bool]$env:CI

# Spawned shells inherit whatever PATH they were started with, which on a dev
# machine is routinely missing node. Rebuild it from the registry. See GOTCHAS.
#
# NOT on CI. A GitHub runner puts node and cargo on the PATH of the *process*,
# via setup-node and rust-toolchain; neither is in the registry. Rebuilding from
# the registry there throws both away, and the build fails on "npm not found"
# several steps after the actual mistake.
if (-not $onCI) {
    $env:Path = "$([Environment]::GetEnvironmentVariable('Path','Machine'));$([Environment]::GetEnvironmentVariable('Path','User'))"
}

$root   = Split-Path -Parent $PSScriptRoot
$libDir = Join-Path $root 'src-tauri\lib'
$relDir = Join-Path $root 'src-tauri\target\release'
$outDir = Join-Path $root 'dist-app'
$dlls   = @('libmpv-2.dll', 'libmpv-wrapper.dll')

# cargo cannot overwrite an exe Windows still has open, and the failure surfaces
# as a confusing linker error rather than a clear one.
$running = Get-Process kinema -ErrorAction SilentlyContinue
if ($running) {
    $pids = $running.Id -join ', '
    throw "Kinema is running (PID $pids). Close it first: the release exe cannot be written while Windows holds it open."
}

foreach ($dll in $dlls) {
    if (-not (Test-Path (Join-Path $libDir $dll))) {
        throw "Missing $dll in src-tauri\lib. Run: npx tauri-plugin-libmpv-api setup-lib"
    }
}

Write-Host 'Building release binary (this takes a few minutes the first time)...'
Push-Location $root
try {
    npm run tauri build -- --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed with exit code $LASTEXITCODE." }
}
finally {
    Pop-Location
}

$exe = Join-Path $relDir 'kinema.exe'
if (-not (Test-Path $exe)) { throw "Build reported success but $exe is not there." }

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Copy-Item $exe $outDir -Force
foreach ($dll in $dlls) { Copy-Item (Join-Path $libDir $dll) $outDir -Force }

$target = Join-Path $outDir 'kinema.exe'

# The app was called Personal Netflix until the rename. A stale exe beside the
# new one is confusing at best; a stale shortcut is worse, because it still
# launches the old binary against the old app-data folder and looks like the
# library has emptied itself.
$oldExe = Join-Path $outDir 'personal-netflix.exe'
if (Test-Path $oldExe) { Remove-Item $oldExe -Force }

if ($NoShortcut -or $onCI) {
    Write-Host 'Skipping the desktop shortcut.'
    $linkPath = '(not created)'
}
else {
    $desktop  = [Environment]::GetFolderPath('Desktop')
    $linkPath = Join-Path $desktop 'Kinema.lnk'

    $oldLink = Join-Path $desktop 'Personal Netflix.lnk'
    if (Test-Path $oldLink) { Remove-Item $oldLink -Force }

    $shell = New-Object -ComObject WScript.Shell
    $link  = $shell.CreateShortcut($linkPath)
    $link.TargetPath       = $target
    $link.WorkingDirectory = $outDir
    $link.IconLocation     = $target
    $link.Description      = 'Kinema'
    $link.Save()
}

$megabytes = [math]::Round((Get-ChildItem $outDir | Measure-Object -Property Length -Sum).Sum / 1MB)

Write-Host ''
Write-Host "App folder: $outDir ($megabytes MB)"
Write-Host "Shortcut:   $linkPath"
Write-Host 'Done. Launch it from the desktop shortcut, no terminal needed.'
