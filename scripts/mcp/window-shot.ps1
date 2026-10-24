<#
.SYNOPSIS
  A screenshot of one process's main window only, for the Kinema MCP.

.DESCRIPTION
  Copies the window's visible rectangle from the screen - so the video mpv
  draws under the see-through page, and a menu that pops up over the window,
  are in it - scaled by -Scale. Nothing outside the window is taken.

  The window is on top during an interactive run (selftest.ts), so nothing of
  the owner's covers it. This file is deliberately ASCII only; see
  build-app.ps1 for why.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][string]$Out,
  [double]$Scale = 0.5
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class KinemaShot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr data);
  // The process's largest visible top-level window: Kinema's own, not the
  // small ones libmpv and WebView2 keep (MainWindowHandle can be one of those).
  public static IntPtr Largest(uint processId) {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows((hwnd, data) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pid != processId || !IsWindowVisible(hwnd)) return true;
      RECT r; DwmGetWindowAttribute(hwnd, 9, out r, 16);
      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > bestArea) { bestArea = area; best = hwnd; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
'@
# Per-monitor aware, so the rectangle and the screen copy are both in real pixels.
[void][KinemaShot]::SetProcessDpiAwarenessContext([IntPtr]-4)

$hwnd = [KinemaShot]::Largest([uint32]$ProcessId)
if ($hwnd -eq [IntPtr]::Zero) { throw "Process $ProcessId has no visible window." }
$rect = New-Object KinemaShot+RECT
# DWMWA_EXTENDED_FRAME_BOUNDS: the visible frame, without the invisible resize border.
[void][KinemaShot]::DwmGetWindowAttribute($hwnd, 9, [ref]$rect, 16)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) { throw 'The window has no size (minimised?).' }

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
# Doubles on purpose: [Math]::Min(1, ...) picks the integer overload and rounds.
$Scale = [Math]::Min([double]1, [Math]::Max([double]0.1, [double]$Scale))
$w = [Math]::Max(1, [int]($width * $Scale))
$h = [Math]::Max(1, [int]($height * $Scale))
$small = New-Object System.Drawing.Bitmap -ArgumentList $w, $h
$smallGraphics = [System.Drawing.Graphics]::FromImage($small)
$smallGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$smallGraphics.DrawImage($bitmap, 0, 0, $w, $h)
$small.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$smallGraphics.Dispose(); $graphics.Dispose(); $bitmap.Dispose(); $small.Dispose()
Write-Output "$($rect.Left),$($rect.Top) ${width}x${height} -> ${w}x${h}"
