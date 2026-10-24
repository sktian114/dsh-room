/**
 * 修会话日志里「收件箱待落盘的毒项」：给 agent/inbox/spliced 的 inserted 项补上
 * role:"user" 与非空 id（内容一字不动）。
 *
 * 为什么需要：dsh-agent-loop 把收件箱里的插入项原样 append 成 user/message，
 * 而 dsh-session 要求 data 有非空 id / role==="user"。旧版 dsh-room 塞进去的
 * { content, source } 一旦落盘，整个会话下次加载就报
 *   session event at seq N lacks an identified message
 * 会话直接打不开。已落盘的坏事件用 session-repair 修；还躺在队列里的用这个修。
 *
 * 注意：这只修磁盘。DSH 进程里那份**内存**收件箱还带着旧对象，所以修完必须重启
 * DSH（或让会话 cancel 掉待处理队列），否则 splice 时又把毒写回去。
 *
 * 用法：
 *   node tools/session-inbox-fix.mjs                 # 干跑，只报告
 *   node tools/session-inbox-fix.mjs --apply         # 真写（先备份 .bak-<ms>）
 *   node tools/session-inbox-fix.mjs --apply <前缀>  # 只处理某个会话
 *
 * ⚠️ 判定「队列里到底还剩什么」不能只看 inserted：移除是**另一条独立的 spliced 事件**
 *    `{ target, start, removedCount: 1, inserted: [] }`。必须按 (target, start) 真做
 *    splice 回放（tools/session-validate.mjs 已经这么做）。否则会把早就出队的项当成
 *    还在队里的「地雷」——2026-10-24 我们就这么误报过一次。
 *    本工具只按「是否存在缺 role/id 的 inserted 项」补字段，改的是历史字节，
 *    在项已出队的情况下无害但也无用；先用 validate 确认还剩没剩。
 */
import { readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decodeSession(file) {
  const raw = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= raw.length; i += 1) {
    if (raw[i] === MAGIC[0] && raw[i + 1] === MAGIC[1] && raw[i + 2] === MAGIC[2] && raw[i + 3] === MAGIC[3]) starts.push(i)
  }
  const chunks = []
  for (let k = 0; k < starts.length; k += 1) {
    const slice = raw.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : raw.length)
    try { chunks.push(zstdDecompressSync(slice)) } catch { /* 坏帧跳过 */ }
  }
  return Buffer.concat(chunks).toString('utf8')
}

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const only = args.find((arg) => !arg.startsWith('--')) || ''
const root = join(homedir(), '.dsh', 'sessions')

let touchedFiles = 0
let touchedItems = 0
for (const workspace of readdirSync(root)) {
  let dirs = []
  try { dirs = readdirSync(join(root, workspace)) } catch { continue }
  for (const dir of dirs) {
    if (only && !dir.includes(only)) continue
    const file = join(root, workspace, dir, 'session.v4.jsonl.zstd')
    let text = ''
    try { text = decodeSession(file) } catch { continue }
    if (!text.includes('agent/inbox/spliced')) continue
    const lines = text.split('\n')
    let changed = 0
    const next = lines.map((line) => {
      if (!line.trim()) return line
      let event
      try { event = JSON.parse(line) } catch { return line }
      const data = event.data
      if (event.type !== 'agent/inbox/spliced' || !data || !Array.isArray(data.inserted)) return line
      let dirty = false
      for (const item of data.inserted) {
        if (!item || typeof item !== 'object') continue
        if (typeof item.id !== 'string' || item.id === '') { item.id = randomUUID(); dirty = true }
        if (item.role !== 'user') { item.role = 'user'; dirty = true }
      }
      if (!dirty) return line
      changed += 1
      return JSON.stringify(event)
    })
    if (!changed) continue
    touchedFiles += 1
    touchedItems += changed
    console.log((apply ? '修复 ' : '待修 ') + dir.slice(0, 24) + '：' + changed + ' 条 inbox/spliced')
    if (!apply) continue
    copyFileSync(file, file + '.bak-' + Date.now())
    writeFileSync(file, zstdCompressSync(Buffer.from(next.join('\n'), 'utf8')))
  }
}

console.log('\n会话文件 ' + touchedFiles + ' 个、待/已修项 ' + touchedItems + ' 条')
if (!apply && touchedFiles) console.log('（干跑；加 --apply 才写，写前会备份 .bak-<时间戳>）')
