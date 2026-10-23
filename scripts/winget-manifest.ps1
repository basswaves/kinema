<#
.SYNOPSIS
  Write Kinema's winget manifest for one release.

.DESCRIPTION
  The three files winget-pkgs wants (version, installer, defaultLocale), for
  the per-user installer on a GitHub release. Written by hand rather than by a
  generator, so a release needs no tool that can change under it; release.yml
  writes and validates them for every tag, and winget.yml writes them again
  from the published file and submits them, when the owner starts it.

  Installing Kinema with winget brings ffmpeg too (Gyan.FFmpeg.Essentials, the
  same package Settings installs with one press), for the detail page's badges.
  Uninstalling Kinema leaves it: other programs may use it.

  ASCII only, like build-app.ps1: powershell.exe reads a .ps1 without a BOM as
  ANSI.

.EXAMPLE
  scripts/winget-manifest.ps1 -Version 0.11.0 -Sha256 <hash> -OutDir out-winget
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$Version,
    # SHA-256 of the installer, as Get-FileHash gives it.
    [Parameter(Mandatory)] [string]$Sha256,
    [Parameter(Mandatory)] [string]$OutDir,
    # The installer's name on the release. Up to 0.12.0 it carried the
    # version; later releases do not.
    [string]$FileName = 'kinema-windows-x64-setup.exe',
    # The day the release is published; today by default.
    [string]$ReleaseDate = (Get-Date -Format 'yyyy-MM-dd')
)

$ErrorActionPreference = 'Stop'

$id = 'Basswaves.Kinema'
$manifestVersion = '1.10.0'
$repo = 'https://github.com/basswaves/kinema'
$url = "$repo/releases/download/v$Version/$FileName"

$files = @{
    "$id.yaml" = @"
# yaml-language-server: `$schema=https://aka.ms/winget-manifest.version.$manifestVersion.schema.json
PackageIdentifier: $id
PackageVersion: $Version
DefaultLocale: en-US
ManifestType: version
ManifestVersion: $manifestVersion
"@
    "$id.installer.yaml" = @"
# yaml-language-server: `$schema=https://aka.ms/winget-manifest.installer.$manifestVersion.schema.json
PackageIdentifier: $id
PackageVersion: $Version
InstallerType: nullsoft
Scope: user
UpgradeBehavior: install
ProductCode: Kinema
ReleaseDate: $ReleaseDate
Dependencies:
  PackageDependencies:
  - PackageIdentifier: Gyan.FFmpeg.Essentials
Installers:
- Architecture: x64
  InstallerUrl: $url
  InstallerSha256: $($Sha256.ToUpper())
ManifestType: installer
ManifestVersion: $manifestVersion
"@
    "$id.locale.en-US.yaml" = @"
# yaml-language-server: `$schema=https://aka.ms/winget-manifest.defaultLocale.$manifestVersion.schema.json
PackageIdentifier: $id
PackageVersion: $Version
PackageLocale: en-US
Publisher: Basswaves
PublisherUrl: https://github.com/basswaves
PublisherSupportUrl: $repo/issues
PackageName: Kinema
PackageUrl: $repo
License: MIT
LicenseUrl: $repo/blob/master/LICENSE
ShortDescription: A local, serverless media library for movies and TV shows
Description: Kinema shows the films and series on your own drives and network shares as a library, and plays them with mpv. It runs no server and needs no account. Made for a TV and a remote as much as for a desk.
Moniker: kinema
Tags:
- media-player
- mpv
- movies
- tv-shows
- video
ReleaseNotesUrl: $repo/releases/tag/v$Version
ManifestType: defaultLocale
ManifestVersion: $manifestVersion
"@
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
foreach ($name in $files.Keys) {
    # UTF-8 without a BOM, LF line ends, as winget-pkgs keeps them.
    $text = ($files[$name] -replace "`r`n", "`n") + "`n"
    [IO.File]::WriteAllText((Join-Path $OutDir $name), $text, (New-Object Text.UTF8Encoding $false))
}
Write-Host "winget manifest for $id $Version in $OutDir"
