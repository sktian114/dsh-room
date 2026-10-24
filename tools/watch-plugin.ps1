<#
.SYNOPSIS
  改完插件源码自动触发 DSH 的「重新组合」，不用退出重进 DSH。

.DESCRIPTION
  DSH 的 @deepseek-ai/dsh-hmr 在 profile 上下文里默认开启（root: [] = 只监听配置）。
  只要 profile 的 cordis.patch.yml 变化一次，它就会重新组合 profile，并把
  「profile 目录下（含 node_modules 与已链接包目标）磁盘上已变化的插件」重新导入 ——
  于是改完 index.mjs / lib/*.js 存盘即可生效，会话与连接都不丢。

  本脚本只做一件事：盯住插件源码目录 → 有变化就改写 cordis.patch.yml 里的一行
  注释（`# hmr-probe <时间戳>`）→ 触发那一次重新组合。内容语义不变，可随时删掉这行。

  用法：
    pwsh -File tools\watch-plugin.ps1
    pwsh -File tools\watch-plugin.ps1 -RoomPort 8787      # 顺带验证版号变化
    pwsh -File tools\watch-plugin.ps1 -Once                # 只触发一次，不常驻

.NOTES
  · 只改客户端 lib/client.js 时不需要这个脚本：浏览器 Ctrl+R 就够了（bundle 带 rev 指纹）。
  · 插件内部状态会丢（房间需要重新开），会话 / 工作区 / 模型上下文都保留。
  · 重载失败不会要求重启：插件会标成 failed 并把错误显示在插件列表里，改好再触发一次即可。
#>
[CmdletBinding()]
param(
  [string]$Source = "E:\E Download\AIWorking\dsh space\dsh-room",
  [string]$Patch = (Join-Path $env:USERPROFILE ".dsh\profiles\desktop\cordis.patch.yml"),
  [int]$RoomPort = 0,
  [int]$DebounceMs = 300,
  [int]$CooldownMs = 2500,
  [switch]$Once
)

$ErrorActionPreference = 'Stop'
function Stamp { (Get-Date).ToString('HH:mm:ss') }
function Say($msg) { Write-Host ("[{0}] {1}" -f (Stamp), $msg) }

if (-not (Test-Path $Source)) { throw "源码目录不存在：$Source" }
if (-not (Test-Path $Patch)) { throw "profile 补丁文件不存在：$Patch" }
$Source = (Resolve-Path $Source).Path
$Patch = (Resolve-Path $Patch).Path

# 只关心真正会被 DSH 加载的文件
function Test-Interesting([string]$path) {
  if (-not $path) { return $false }
  $rel = $path.Substring($Source.Length).TrimStart('\', '/')
  if ($rel -match '^(\.git|node_modules|test|docs|tools)(\\|/)') { return $false }
  if ($path -match '~(～)?\$|\.tmp$|\.log$|\.bak') { return $false }
  return ($rel -match '(^|\\)(package\.json|[^\\]+\.(mjs|js|json|yml|yaml))$')
}

function Get-PluginVersion {
  if (-not $RoomPort) { return $null }
  try {
    $r = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/room/api/host/state" -f $RoomPort) -TimeoutSec 3 -UseBasicParsing
    return (($r.Content | ConvertFrom-Json).version)
  } catch { return $null }
}

function Invoke-Recompose([string]$reason) {
  $before = Get-PluginVersion
  $stamp = '# hmr-probe ' + (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fff')
  $text = [System.IO.File]::ReadAllText($Patch)
  if ($text -match '(?m)^# hmr-probe .*$') {
    $text = [regex]::Replace($text, '(?m)^# hmr-probe .*$', $stamp)
  } else {
    $text = $stamp + "`r`n" + $text
  }
  [System.IO.File]::WriteAllText($Patch, $text, [System.Text.UTF8Encoding]::new($false))
  Say ("触发重新组合 ← {0}" -f $reason)
  if (-not $RoomPort) { return }
  # HMR 的配置监听带 awaitWriteFinish（默认 2 秒写入稳定窗口），所以别急着查
  for ($i = 0; $i -lt 14; $i += 1) {
    Start-Sleep -Milliseconds 700
    $now = Get-PluginVersion
    if (-not $now) {
      Say "  ✅ 房间端口已断开 → 插件确实被重新组合（房间需要重开）"
      return
    }
    if ($before -and $now -ne $before) { Say ("  ✅ 已重载：{0} → {1}" -f $before, $now); return }
  }
  Say ("  ⚠ 12 秒内没看到重载迹象（版号仍是 {0}）；去插件列表看看是不是 failed" -f $before)
}

if ($Once) {
  Invoke-Recompose "手动 -Once"
  return
}

Say "监听 $Source"
Say "触发文件 $Patch"
if ($RoomPort) { Say "验证端口 $RoomPort（读 /room/api/host/state 的 version）" } else { Say "未指定 -RoomPort，跳过版号验证" }

$watcher = New-Object System.IO.FileSystemWatcher $Source
$watcher.IncludeSubdirectories = $true
$watcher.EnableRaisingEvents = $false
$watcher.NotifyFilter = [System.IO.NotifyFilters]::FileName -bor [System.IO.NotifyFilters]::LastWrite -bor [System.IO.NotifyFilters]::Size

$pending = $null          # 防抖截止时间
$pendingReason = ''
$lastFire = [datetime]::MinValue
$serial = 0

$subscriptions = @()
foreach ($name in @('Changed', 'Created', 'Renamed', 'Deleted')) {
  $subscriptions += Register-ObjectEvent -InputObject $watcher -EventName $name -SourceIdentifier ("dsh-room-" + $name.ToLower())
}

Say "就绪，Ctrl+C 退出"
$watcher.EnableRaisingEvents = $true

try {
  while ($true) {
    $event = Wait-Event -Timeout 1
    if ($event) {
      $path = $null
      try { $path = $event.SourceEventArgs.FullPath } catch { $path = $null }
      if ($path -and (Test-Interesting $path)) {
        $pending = (Get-Date).AddMilliseconds($DebounceMs)
        $pendingReason = (Split-Path $path -Leaf)
        Write-Verbose ("变化：{0}" -f $path)
      }
      Remove-Event -EventIdentifier $event.EventIdentifier
    }
    if ($pending -and (Get-Date) -ge $pending) {
      if (((Get-Date) - $lastFire).TotalMilliseconds -lt $CooldownMs) {
        $pending = (Get-Date).AddMilliseconds($CooldownMs - ((Get-Date) - $lastFire).TotalMilliseconds)
        continue
      }
      $pending = $null
      $serial += 1
      try {
        Invoke-Recompose ("{0}（第 {1} 次）" -f $pendingReason, $serial)
        $lastFire = Get-Date
      } catch {
        Say ("触发失败：{0}" -f $_.Exception.Message)
      }
    }
  }
} finally {
  $watcher.EnableRaisingEvents = $false
  foreach ($sub in $subscriptions) { try { Unregister-Event -SourceIdentifier $sub.Name -ErrorAction SilentlyContinue } catch { } }
  $watcher.Dispose()
  Say "已停止监听"
}
