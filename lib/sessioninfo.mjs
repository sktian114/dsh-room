/**
 * 从 DSH 的会话文件里问出「这条会话属于哪个工作区」。
 *
 * 为什么要这个：房客发指令（session/prompt）时，守卫必须知道会话 → 工作区路径，
 * 才能按房主开放的目录判权限。平时这份对应关系是从界面的 session/list 回执和
 * WS 的 workspace 帧里学的，但只要那一步没走到（换连接、还没拉列表、接口形状变了），
 * 房客发什么都一律被判 workspace-blocked —— 真机症状就是「这个目录房主没有开放」。
 * 这里直接从磁盘上的会话头里读 cwd，给守卫补一手，不依赖界面行为。
 *
 * 会话文件是多帧 zstd（`session.v4.jsonl.zstd`），头事件在第一帧，解一帧就够。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import * as nodeZlib from 'node:zlib'

// zstd 解压是 Node 22.15 才有的（`zstdDecompressSync`）。Node 20 上这个命名导入会直接
// 抛 SyntaxError 把插件整个带崩（GitHub Actions 的 Node 20 矩阵就是这么红的）。
// 所以按命名空间导入 + 运行时探测：老 Node 上退化成「读不到会话头」——
// 调用方本来就有兜底路径（`session/list`、界面行为），只是守卫少一手信息。
const zstdDecompressSync = typeof nodeZlib.zstdDecompressSync === 'function'
  ? nodeZlib.zstdDecompressSync
  : null

/** 当前 Node 是否支持 zstd（Node < 22.15 不支持）。 */
export function zstdAvailable() {
  return Boolean(zstdDecompressSync)
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** DSH 数据目录（测试里用 DSH_HOME 指到临时目录）。 */
export function dshHome() {
  const override = String(process.env.DSH_HOME || '').trim()
  return override || join(homedir(), '.dsh')
}

/**
 * 从 prompt 信封里取出目标会话 id（取不到返回空串）。
 * 兼容三种写法：request.sessionId / request.address.sessionId / args.sessionId。
 * @param {string} bodyText 原始请求体
 * @returns {string}
 */
export function promptSessionId(bodyText) {
  let payload
  try { payload = JSON.parse(bodyText) } catch { return '' }
  const args = payload && payload.payload && payload.payload.args
  const request = (args && args.request) || {}
  const id = request.sessionId
    || (request.address && request.address.sessionId)
    || (args && (args.sessionId || args.agentId))
    || ''
  return String(id || '')
}

/**
 * 读某个会话头事件里的 cwd（找不到返回空串）。
 * @param {string} sessionId
 * @param {string} [root] 会话根目录，默认 <dshHome>/sessions
 * @returns {string}
 */
export function cwdFromSessionFile(sessionId, root) {
  const id = String(sessionId || '')
  if (!id) return ''
  const base = root || join(dshHome(), 'sessions')
  let workspaces = []
  try { workspaces = readdirSync(base) } catch { return '' }
  for (const workspace of workspaces) {
    const file = join(base, workspace, id, 'session.v4.jsonl.zstd')
    let raw = null
    try { raw = readFileSync(file) } catch { continue }
    const first = raw.indexOf(ZSTD_MAGIC)
    const second = raw.indexOf(ZSTD_MAGIC, first + ZSTD_MAGIC.length)
    const slice = raw.subarray(first < 0 ? 0 : first, second < 0 ? raw.length : second)
    let text = ''
    if (zstdDecompressSync) {
      try { text = zstdDecompressSync(slice).toString('utf8') } catch { text = raw.toString('latin1') }
    } else {
      // 老 Node：没有 zstd，退化成按 latin1 扫明文（JSON 的 cwd 字段有时恰好是明文片段）
      text = raw.toString('latin1')
    }
    // 先按行 JSON.parse（真机头事件就是一行 JSON）；解析不了再退回正则 + 反转义
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event && typeof event.cwd === 'string' && event.cwd) return event.cwd
    }
    const match = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)
    if (!match) continue
    try { return JSON.parse('"' + match[1] + '"') } catch { return match[1].replace(/\\\\/g, '\\') }
  }
  return ''
}

/**
 * 从 DSH 的投影缓存里读会话标题（找不到返回空串）。
 *
 * 为什么要这个：把子 agent 拉进群时要给它一个默认别名，而子 agent 常常是**歇着的**
 * （没有活句柄），`session/list` 也可能暂时拿不到（没 cookie、换连接、接口形状变了）。
 * 这时别名会退化成整条 UUID，污染成员列表和 @点名。投影缓存是磁盘上的兜底：
 *   <dshHome>/storages/session_projcache/sessions/<id>.json
 *   → { "title": { "ver":1, "seq":65, "val":"标题" } }
 *
 * @param {string} sessionId
 * @param {string} [root] 缓存根目录，默认 <dshHome>/storages/session_projcache/sessions
 * @returns {string}
 */
export function titleFromProjectionCache(sessionId, root) {
  const id = String(sessionId || '').trim()
  if (!id) return ''
  const base = root || join(dshHome(), 'storages', 'session_projcache', 'sessions')
  let text = ''
  try { text = readFileSync(join(base, id + '.json'), 'utf8') } catch { return '' }
  let parsed = null
  try { parsed = JSON.parse(text) } catch { return '' }
  // 两种形状都认：{ title: { val } } 与 { rows: { title: { val } } }
  const candidates = [
    parsed && parsed.title,
    parsed && parsed.rows && parsed.rows.title,
    parsed && parsed.projections && parsed.projections.title,
  ]
  for (const item of candidates) {
    const value = item && (item.val !== undefined ? item.val : item.value)
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}
