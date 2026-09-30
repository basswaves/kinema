<#
.SYNOPSIS
  Run a command on Linux, in WSL, against exactly what is in this working tree.

.DESCRIPTION
  Examples, from the project root:

    scripts\wsl.ps1 'npm run check'
    scripts\wsl.ps1 'cargo test --manifest-path src-tauri/Cargo.toml'

  The command is one quoted string, run by bash. Left unquoted, PowerShell
  reads `--manifest-path` as a parameter of this script and stops.

  The Linux side works on its own copy, ~/kinema inside the distribution, never
  on this folder. One checkout cannot serve both systems: node_modules and
  src-tauri/target hold binaries for one platform, and building across /mnt/c
  is many times slower. The copy is a mirror and nothing else - never edit it;
  every run overwrites it.

  The copy is made through git, not by copying files. With core.autocrlf the
  files here have Windows line endings, which a Linux checkout (and CI) never
  sees. So this snapshots the working tree - uncommitted and untracked work
  included, .gitignore respected - into a commit that no branch points at,
  using a throwaway index so the real one is untouched, and the Linux side
  checks that commit out with Linux line endings. The temporary ref is deleted
  again at once; the commit is left for git's own garbage collection.

  node_modules is reinstalled only when package-lock.json changes. The
  distribution needs the build tools once; notes on them are in CONTRIBUTING.

  This file is deliberately ASCII only; see build-app.ps1 for why.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory, Position = 0)]
    [string]$Command,
    [string]$Distro = 'Ubuntu-24.04'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$ref  = 'refs/wsl/snapshot'
$tmp  = New-TemporaryFile

try {
    $env:GIT_INDEX_FILE = $tmp.FullName
    git -C $root read-tree HEAD
    # safecrlf off: otherwise every file a tool saved with LF endings prints a
    # warning here, about a conversion this snapshot never makes.
    git -C $root -c core.safecrlf=false add -A
    $tree = git -C $root write-tree
    if ($LASTEXITCODE -ne 0) { throw 'git could not snapshot the working tree' }
} finally {
    Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue
    Remove-Item $tmp -ErrorAction SilentlyContinue
}

$commit = git -C $root commit-tree $tree -p HEAD -m 'WSL snapshot of the working tree'
git -C $root update-ref $ref $commit

try {
    $src = (wsl -d $Distro --exec wslpath -a "$root").Trim()
    if ($LASTEXITCODE -ne 0) { throw "WSL distribution '$Distro' is not available" }

    # Written to a file with LF endings and run from there, not piped: piping
    # text into a native program makes PowerShell end it with CRLF, and bash
    # then reads `check<CR>` as the name of the npm script.
    $script = @"
set -e
. "`$HOME/.cargo/env" 2>/dev/null || true
dst="`$HOME/kinema"
mkdir -p "`$dst"
cd "`$dst"
[ -d .git ] || git init -q
git -c safe.directory='*' fetch -q --no-tags '$src' $ref
git checkout -q -f --detach FETCH_HEAD
git clean -q -fd
lock=`$(sha1sum package-lock.json | cut -d' ' -f1)
if [ "`$(cat node_modules/.kinema-lock 2>/dev/null)" != "`$lock" ]; then
  npm ci --no-audit --no-fund
  echo "`$lock" > node_modules/.kinema-lock
fi
$Command
"@
    $file = New-TemporaryFile
    [IO.File]::WriteAllText($file.FullName, ($script -replace "`r", ''))
    wsl -d $Distro --exec bash (wsl -d $Distro --exec wslpath -a "$($file.FullName)").Trim()
    $status = $LASTEXITCODE
} finally {
    git -C $root update-ref -d $ref
    if ($file) { Remove-Item $file -ErrorAction SilentlyContinue }
}

exit $status
