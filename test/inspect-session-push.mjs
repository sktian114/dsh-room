/**
 * 从会话日志里找「房间消息推送」与作者标记，验证两件事：
 *   1. 推送文本是**落盘**的（重启不丢）
 *   2. 0.3.10 之后推的带 `〔@别名〕`，之前推的是旧格式（`【房间消息·…】session-…：`）
 *
 *   node test/inspect-session-push.mjs <sessionId|目录名片段> [根目录]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const needle = String(process.argv[2] || '').trim()
if (!needle) {
  console.log('用法：node test/inspect-session-push.mjs <sessionId> [会话根目录]')
  process.exit(1)
}
const base = process.argv[3] || join(homedir(), '.dsh', 'sessions')

function framesOf(raw) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  let at = raw.indexOf(magic)
  while (at >= 0) {
    offsets.push(at)
    at = raw.indexOf(magic, at + magic.length)
  }
  const frames = []
  for (let i = 0; i < offsets.length; i += 1) {
    const slice = raw.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : raw.length)
    try { frames.push(zstdDecompressSync(slice).toString('utf8')) } catch { /* 坏帧跳过 */ }
  }
  return frames.join('')
}

let file = ''
const workspaces = readdirSync(base)
for (const workspace of workspaces) {
  const candidate = join(base, workspace, needle, 'session.v4.jsonl.zstd')
  try { readFileSync(candidate); file = candidate; break } catch { /* 继续找 */ }
}
if (!file) {
  console.log('找不到会话文件：' + needle)
  process.exit(1)
}
const text = framesOf(readFileSync(file))
const pushes = text.split('【房间消息·').length - 1
const marks = text.split('〔@').length - 1
console.log(JSON.stringify({
  file,
  bytes: text.length,
  pushes,
  marks,
  firstMarkSample: marks ? text.slice(Math.max(0, text.indexOf('〔@') - 60), text.indexOf('〔@') + 120) : null,
  firstPushSample: pushes ? text.slice(Math.max(0, text.indexOf('【房间消息·') - 40), text.indexOf('【房间消息·') + 100) : null,
}, null, 2))
