<#
.SYNOPSIS
  Run the real app, with the real mpv, through a scripted playback session.

.DESCRIPTION
  Starts kinema.exe with KINEMA_SELFTEST pointing at a plan file. The app
  works on a snapshot copy of the library in <plan folder>\data - the real
  library is never written - plays the plan's file muted, carries out the
  plan's actions, writes report.json beside the plan and exits.

  While it runs, this script takes screenshots of the primary screen at the
  given times (milliseconds after launch), scaled to a quarter, as
  shot-NNNNNms.png beside the plan. They are how the look of the first
  second - the see-through window, the black cover - is checked without a
  person watching.

  A plan looks like:

    {
      "path": "D:\\TV\\Show\\Show.S01E01.mkv",
      "fileId": 48,
      "titleId": 4,
      "seconds": 30,
      "actions": [ { "at": 6, "do": "key", "key": "Enter" } ]
    }

  fileId and titleId are optional (null plays the file ad hoc, with no
  resume point and no remembered tracks). "do" is key, seek (with "to") or
  mark. See src/selftest.ts.

  Delete <plan folder>\data to start again from a fresh copy of the library.

  This file is deliberately ASCII only; see build-app.ps1 for why.

.EXAMPLE
  .\scripts\selftest.ps1 -Plan C:\tmp\run1\plan.json
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Plan,
  [string]$Exe = '',
  # Text, not [int[]]: with -File an array arrives as one string, and under a
  # locale that reads ',' as a decimal separator '700,8000' became a single
  # huge number - a screenshot two hours away, and a script that never ends.
  [string]$ShotsAt = '300,700,1100,1600,2300,3500,8000',
  [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# $PSScriptRoot is empty in a param() default under Windows PowerShell 5.1.
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot '..\src-tauri\target\release\kinema.exe' }
$Plan = (Resolve-Path $Plan).Path
$Exe = (Resolve-Path $Exe).Path
$out = Split-Path $Plan
$exeDir = Split-Path $Exe

foreach ($dll in 'libmpv-2.dll', 'libmpv-wrapper.dll') {
  if (-not (Test-Path (Join-Path $exeDir $dll))) {
    $lib = Join-Path $PSScriptRoot "..\src-tauri\lib\$dll"
    Write-Host "Copying $dll beside the exe"
    Copy-Item $lib $exeDir
  }
}

Remove-Item (Join-Path $out 'report.json') -ErrorAction SilentlyContinue
Get-ChildItem $out -Filter 'shot-*.png' | Remove-Item

$env:KINEMA_SELFTEST = $Plan
$start = Get-Date
$process = Start-Process -FilePath $Exe -WorkingDirectory $exeDir -PassThru
Remove-Item Env:\KINEMA_SELFTEST

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$shots = $ShotsAt -split '[,; ]+' | Where-Object { $_ } | ForEach-Object { [int]$_ } | Sort-Object
foreach ($ms in $shots) {
  while (((Get-Date) - $start).TotalMilliseconds -lt $ms) { Start-Sleep -Milliseconds 10 }
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $small = New-Object System.Drawing.Bitmap $bitmap, ([int]($bounds.Width / 4)), ([int]($bounds.Height / 4))
  $small.Save((Join-Path $out ('shot-{0:D5}ms.png' -f $ms)))
  $graphics.Dispose(); $bitmap.Dispose(); $small.Dispose()
}

if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
  Stop-Process -Id $process.Id -Force
  throw "The self-test did not finish within $TimeoutSeconds s; stopped it. See $out\data\logs\app.log"
}

$report = Join-Path $out 'report.json'
if (-not (Test-Path $report)) {
  throw "The app exited without a report. See $out\data\logs\app.log"
}
Write-Host "Report: $report"
