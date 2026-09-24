<#
  Kinema automatic test for the TV PC. Runs each plan folder beside this file
  through selftest.ps1 with the Kinema on this stick, then copies every
  report, screenshot and log into "Logs from the TV PC" on the stick.
  ASCII only, like selftest.ps1.
#>
$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$stick = Split-Path $here
$exe = Join-Path $stick 'Kinema\kinema.exe'
$out = Join-Path $stick 'Logs from the TV PC'
New-Item -ItemType Directory -Force $out | Out-Null
Add-Type -AssemblyName System.Windows.Forms
# Without this, Windows reports a 4K screen at 300 % scaling as 1280x720.
Add-Type -Name Dpi -Namespace Kinema -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][Kinema.Dpi]::SetProcessDPIAware()

$summary = @()
$summary += "Automatic test, $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
$summary += "Screen before: $([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Size)"

foreach ($plan in Get-ChildItem $here -Recurse -Filter plan.json) {
  $dir = $plan.DirectoryName
  $name = Split-Path $dir -Leaf
  Write-Host ""
  Write-Host "=== $name - please do not touch anything ==="
  # A fresh copy of the library for every run.
  $data = Join-Path $dir 'data'
  if (Test-Path $data) { Remove-Item $data -Recurse -Force }
  & (Join-Path $here 'selftest.ps1') -Plan $plan.FullName -Exe $exe -ShotsAt '8000,16000,26000' -TimeoutSeconds 120
  Start-Sleep -Seconds 5
  $summary += "After ${name}: $([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Size)"
  $dest = Join-Path $out "auto-$name"
  New-Item -ItemType Directory -Force $dest | Out-Null
  Copy-Item (Join-Path $dir 'report.json') $dest -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $dir 'shot-*.png') $dest -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $data 'logs\*.log') $dest -ErrorAction SilentlyContinue
}

$summary | Set-Content (Join-Path $out 'auto-summary.txt')
Write-Host ""
Write-Host "Done. Everything is in 'Logs from the TV PC' on the stick."
Write-Host "If the TV is now in the wrong mode, write down what it shows."
