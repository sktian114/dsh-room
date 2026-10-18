param(
  [string]$Profile = "desktop",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$package = "@sktian114/dsh-room"
$src = $PSScriptRoot
$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$profileDir = Join-Path $homeDir "profiles\$Profile"
$nodeModules = Join-Path $profileDir "node_modules"
$dest = Join-Path $nodeModules "sktian114\dsh-room"
$legacy = Join-Path $nodeModules "dsh-room"
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
  foreach ($dir in @($dest, $legacy)) {
    if (Test-Path $dir) {
      Remove-Item -Recurse -Force $dir
      Write-Host "Removed $dir"
    }
  }
  if (Test-Path $patch) {
    Backup-Patch
    $text = Get-Content -Raw -Encoding UTF8 $patch
    $text = [regex]::Replace($text, "(?ms)^- insert:\r?\n    - id: dsh-room\r?\n      name: .*?(?:\r?\n|$)", "")
    [System.IO.File]::WriteAllText($patch, $text, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Removed dsh-room mount entry."
  }
  Write-Host "Done. Fully quit and restart DSH."
  exit 0
}

foreach ($dir in @($dest, $legacy)) {
  if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Recurse -Force $src $dest
# 仓库元数据 / 开发用品不往插件目录里拷
foreach ($junk in @("install.ps1", "install.mjs", "preview", "test", "docs", ".git", ".github")) {
  Remove-Item -Recurse -Force (Join-Path $dest $junk) -ErrorAction SilentlyContinue
}

if (-not (Test-Path $patch)) {
  New-Item -ItemType File -Path $patch | Out-Null
}

$text = Get-Content -Raw -Encoding UTF8 $patch
if ($text -notmatch "id:\s*dsh-room") {
  Backup-Patch
  $block = "`n- insert:`n    - id: dsh-room`n      name: `"$package`"`n"
  Add-Content -Path $patch -Value $block -Encoding UTF8
  Write-Host "Mount entry added to $patch"
} else {
  Write-Host "Mount entry already present."
}

Write-Host ""
Write-Host "Installed to: $dest"
Write-Host "Next: fully quit DSH (tray -> Quit), start it again, open a session."
Write-Host "Look for the room-join button at the right side of the composer (label in Chinese)."
