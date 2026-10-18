param(
  [string]$Profile = "desktop",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$src = $PSScriptRoot
$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$profileDir = Join-Path $homeDir "profiles\$Profile"
$dest = Join-Path $profileDir "node_modules\dsh-room"
$patch = Join-Path $profileDir "cordis.patch.yml"

if (-not (Test-Path $profileDir)) {
  throw "DSH profile not found: $profileDir"
}

function Backup-Patch {
  if (Test-Path $patch) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Copy-Item $patch "$patch.bak-$stamp"
  }
}

if ($Uninstall) {
  if (Test-Path $dest) {
    Remove-Item -Recurse -Force $dest
    Write-Host "Removed $dest"
  }
  if (Test-Path $patch) {
    Backup-Patch
    $text = Get-Content -Raw -Encoding UTF8 $patch
    $text = [regex]::Replace($text, "(?ms)^- insert:\r?\n    - id: dsh-room\r?\n      name: dsh-room\r?\n", "")
    [System.IO.File]::WriteAllText($patch, $text, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Removed dsh-room mount entry."
  }
  Write-Host "Done. Fully quit and restart DSH."
  exit 0
}

if (Test-Path $dest) {
  Remove-Item -Recurse -Force $dest
}
New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
Copy-Item -Recurse -Force $src $dest
Remove-Item -Force (Join-Path $dest "install.ps1") -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Join-Path $dest "preview") -ErrorAction SilentlyContinue
# 仓库元数据不往插件目录里拷（这个目录已经 git init 过）
Remove-Item -Recurse -Force (Join-Path $dest ".git") -ErrorAction SilentlyContinue

if (-not (Test-Path $patch)) {
  New-Item -ItemType File -Path $patch | Out-Null
}

$text = Get-Content -Raw -Encoding UTF8 $patch
if ($text -notmatch "id:\s*dsh-room") {
  Backup-Patch
  $block = "`n- insert:`n    - id: dsh-room`n      name: dsh-room`n"
  Add-Content -Path $patch -Value $block -Encoding UTF8
  Write-Host "Mount entry added to $patch"
} else {
  Write-Host "Mount entry already present."
}

Write-Host ""
Write-Host "Installed to: $dest"
Write-Host "Next: fully quit DSH (tray -> Quit), start it again, open a session."
Write-Host "Look for the room-join button at the right side of the composer (label in Chinese)."
