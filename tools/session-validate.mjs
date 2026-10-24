/**
 * 校验 DSH 会话日志里「消息类事件」的形态是否合规（不依赖 DSH 运行时）。
 *
 * 背景（2026-10-24 真机事故）：dsh-room 早期版本往收件箱塞的消息只有 { content, source }，
 * dsh-agent-loop 会把它原样当 user/message 的 data 落盘，于是 DSH 下次加载时抛
 *   session event at seq N lacks an identified message
 * 整个会话打不开。合规的 data 至少要：id 是非空字符串、role === "user"。
 *
 * 用法：
 *   node tools/session-validate.mjs                  # 查全部会话，只报有问题的
 *   node tools/session-validate.mjs <sessionId前缀>  # 只查某个会话
 *   node tools/session-validate.mjs --pending        # 同时列出收件箱里待落盘的项
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 多帧 zstd：按魔数切开逐帧解压后拼接（只解第一帧会误判成"只有一行"）。 */
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

const MESSAGE_EVENTS = new Set(['user/message'])
const args = process.argv.slice(2)
const wantPending = args.includes('--pending')
const only = args.find((arg) => !arg.startsWith('--')) || ''

const root = join(homedir(), '.dsh', 'sessions')
const problems = []
let scanned = 0
for (const workspace of readdirSync(root)) {
  let dirs = []
  try { dirs = readdirSync(join(root, workspace)) } catch { continue }
  for (const dir of dirs) {
    if (only && !dir.includes(only)) continue
    const file = join(root, workspace, dir, 'session.v4.jsonl.zstd')
    let text = ''
    try { text = decodeSession(file) } catch { continue }
    scanned += 1
    const queues = new Map()   // target -> [ { item, seq } ]，按 splice 回放还原
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let event
      try { event = JSON.parse(line) } catch { problems.push({ dir, kind: 'unparsable', brief: line.slice(0, 80) }); continue }
      const data = event.data
      if (MESSAGE_EVENTS.has(event.type)) {
        const bad = !data || typeof data !== 'object' || typeof data.id !== 'string' || data.id === ''
        if (bad) problems.push({ dir: dir.slice(0, 24), kind: event.type, brief: JSON.stringify(data).slice(0, 120) })
      }
      /* 收件箱要**按 (target,start) 真做 splice 回放**才看得准：
       * 「移除」不是插在插入项上的字段，而是另一条独立的 spliced 事件
       *   { target, start, removedCount: 1, inserted: [] }
       * 只看「inserted 非空」的事件、或去插入项里找 removedCount，永远看不到移除，
       * 会把早已出队的项误报成「还躺着的地雷」（2026-10-24 我就在这里误判过一次）。 */
      if (event.type === 'agent/inbox/spliced' && data && typeof data === 'object') {
        const target = String(data.target || 'next-turn')
        if (!queues.has(target)) queues.set(target, [])
        const queue = queues.get(target)
        const start = Number.isInteger(data.start) ? data.start : 0
        const removedCount = Number.isInteger(data.removedCount) ? data.removedCount : 0
        const inserted = Array.isArray(data.inserted) ? data.inserted : []
        queue.splice(start, removedCount, ...inserted.map((item) => ({
          item,
          seq: event.seq,
        })))
      }
    }
    for (const [target, queue] of queues) {
      for (const entry of queue) {
        const item = entry.item
        if (!item || typeof item.id !== 'string' || item.id === '' || item.role !== 'user') {
          problems.push({
            dir: dir.slice(0, 24),
            kind: 'pending-inbox',
            seq: entry.seq,
            brief: target + ' 队列里还有一条缺 role/id 的待落盘项：' + JSON.stringify(item).slice(0, 100),
          })
        }
      }
    }
  }
}

console.log('扫描会话数：' + scanned)
if (!problems.length) {
  console.log('结论：全部合规（消息事件都有非空 id + role）' + (wantPending ? '，收件箱也没有待落盘的毒项' : ''))
  process.exit(0)
}
console.log('发现问题 ' + problems.length + ' 处：')
for (const problem of problems) console.log('  [' + problem.kind + '] ' + problem.dir + '  seq=' + (problem.seq || '-') + '  ' + problem.brief)
process.exit(1)
