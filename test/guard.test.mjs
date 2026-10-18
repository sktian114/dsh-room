/**
 * 房客守卫与 WS 帧过滤的单测（不依赖 DSH）：
 *   node test/guard.test.mjs
 */
import { strict as assert } from 'node:assert'
import { createGuestGuard } from '../lib/guard.mjs'
import { createFrameTransformer } from '../lib/frames.mjs'

const blockedRoot = 'C:\\secret'
const allowedRoot = 'C:\\work'
const writeRoot = 'C:\\work2'

function isBlockedPath(target) {
  const path = String(target || '').toLowerCase()
  return path === 'c:\\secret' || path.startsWith('c:\\secret\\')
}

const sep = String.fromCharCode(92)
function modeForPath(target) {
  const path = String(target || '').toLowerCase()
  if (path === blockedRoot.toLowerCase() || path.startsWith(blockedRoot.toLowerCase() + sep)) return 'blocked'
  if (path === allowedRoot.toLowerCase() || path.startsWith(allowedRoot.toLowerCase() + sep)) return 'readonly'
  if (path === writeRoot.toLowerCase() || path.startsWith(writeRoot.toLowerCase() + sep)) return 'write'
  return 'full'
}
const guard = createGuestGuard({ isBlockedPath, modeForPath })

/* ── 1. workspace/follow 基线：封锁工作区整条消失 ── */
const openFrame = { type: 'open', streamId: 's1', endpoint: 'workspace/follow', payload: { args: {} } }
guard.clientFrame(openFrame)
const baseline = {
  type: 'item',
  streamId: 's1',
  value: {
    type: 'baseline',
    value: {
      items: [
        { workspaceId: 'w-secret', path: blockedRoot, title: 'secret', sessionIds: ['sess-secret'] },
        { workspaceId: 'w-work', path: allowedRoot, title: 'work', sessionIds: ['sess-work'] },
      ],
      archivedSessionIds: ['sess-secret', 'sess-work'],
      pinnedSessionIds: ['sess-secret'],
    },
  },
}
const filteredBaseline = guard.serverFrame(structuredClone(baseline))
assert.equal(filteredBaseline.value.value.items.length, 1)
assert.equal(filteredBaseline.value.value.items[0].workspaceId, 'w-work')
assert.deepEqual(filteredBaseline.value.value.archivedSessionIds, ['sess-work'])
assert.deepEqual(filteredBaseline.value.value.pinnedSessionIds, [])

/* ── 2. workspace/follow 增量：封锁工作区的 upsert 直接丢帧 ── */
const upsertBlocked = {
  type: 'item',
  streamId: 's1',
  value: { type: 'upsert', workspace: { workspaceId: 'w-secret2', path: blockedRoot + '\\x', title: 'x', sessionIds: [] } },
}
assert.equal(guard.serverFrame(upsertBlocked), null)
const upsertAllowed = {
  type: 'item',
  streamId: 's1',
  value: { type: 'upsert', workspace: { workspaceId: 'w-work2', path: allowedRoot + '\\y', title: 'y', sessionIds: [] } },
}
assert.ok(guard.serverFrame(upsertAllowed))

/* ── 3. session/control：封锁工作区里的会话投影被剔除 ── */
const openControl = { type: 'open', streamId: 's2', endpoint: 'session/control', payload: { args: {} } }
guard.clientFrame(openControl)
const controlBaseline = {
  type: 'item',
  streamId: 's2',
  value: {
    type: 'baseline',
    value: { projections: { 'sess-secret': { asOfSeq: 1 }, 'sess-work': { asOfSeq: 2 } } },
  },
}
const filteredControl = guard.serverFrame(structuredClone(controlBaseline))
assert.deepEqual(Object.keys(filteredControl.value.value.projections), ['sess-work'])
const projectionFrame = { type: 'item', streamId: 's2', value: { type: 'projection', sessionId: 'sess-secret', key: 'title', value: '秘密' } }
assert.equal(guard.serverFrame(projectionFrame), null)

/* ── 4. $events：审批 / 提问的 waterfall 不发给房客，其它事件照常 ── */
const openEvents = { type: 'open', streamId: 's3', endpoint: '$events', payload: { args: {} } }
guard.clientFrame(openEvents)
assert.equal(guard.serverFrame({ type: 'item', streamId: 's3', value: { type: 'waterfall', event: 'approval/request', eventId: 'e1' } }), null)
assert.equal(guard.serverFrame({ type: 'item', streamId: 's3', value: { type: 'waterfall', event: 'user-questions/request', eventId: 'e2' } }), null)
assert.ok(guard.serverFrame({ type: 'item', streamId: 's3', value: { type: 'waterfall', event: 'session/added', eventId: 'e3' } }))
assert.ok(guard.serverFrame({ type: 'item', streamId: 's3', value: { type: 'ready', clientId: 'c1' } }))

/* ── 5. HTTP：审批回答与封锁路径 ── */
const url = new URL('http://room.invalid/api/$events/result')
assert.equal(guard.judgeRequest('/api/$events/result', 'POST', url), 'approval-owner-only')
assert.equal(guard.judgeRequest('/api/file', 'GET', new URL('http://room.invalid/api/file?path=' + encodeURIComponent(blockedRoot + '\\a.txt'))), 'workspace-blocked')
assert.equal(guard.judgeRequest('/api/file', 'GET', new URL('http://room.invalid/api/file?path=' + encodeURIComponent(allowedRoot + '\\a.txt'))), null)
const createBody = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/create', payload: { args: { request: { cwd: blockedRoot } } } })
assert.deepEqual(guard.judgeBody('/api/session/create', createBody), { deny: 'workspace-blocked' })
// 只读工作区：房客不能新建会话（连建都不行，避免“能操作”）
const createOk = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/create', payload: { args: { request: { cwd: allowedRoot } } } })
assert.deepEqual(guard.judgeBody('/api/session/create', createOk), { deny: 'workspace-readonly' })
const createWritable = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/create', payload: { args: { request: { cwd: writeRoot } } } })
assert.deepEqual(guard.judgeBody('/api/session/create', createWritable), { create: { mode: 'write' } })
// 没有 cwd、工作区 id 也不认识 → 拒绝（不猜默认工作区）
const createUnknown = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/create', payload: { args: { request: { workspaceId: 'nope' } } } })
assert.deepEqual(guard.judgeBody('/api/session/create', createUnknown), { deny: 'workspace-blocked' })
// 房客不能自己切权限 / 改默认预设
const cmdBody = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'commands/execute', payload: { args: { agentId: 'a', line: '/permission danger-full-access' } } })
assert.deepEqual(guard.judgeBody('/api/commands/execute', cmdBody), { deny: 'permission-locked' })
// 只读工作区里的会话：发消息 / 取消 / 改标题全部拒绝
function promptBody(sessionId) {
  return JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/prompt', payload: { args: { request: { sessionId, prompt: '帮我改文件' } } } })
}
assert.deepEqual(guard.judgeBody('/api/session/prompt', promptBody('sess-work')), { deny: 'workspace-readonly' })
assert.deepEqual(guard.judgeBody('/api/session/prompt', promptBody('sess-secret')), { deny: 'workspace-blocked' })
assert.deepEqual(guard.judgeBody('/api/session/prompt', promptBody('unknown-session')), { deny: 'workspace-blocked' })
// 没见过的会话也不许操作（安全默认）
assert.deepEqual(guard.judgeBody('/api/session/prompt', JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/prompt', payload: { args: { request: {} } } })), { deny: 'workspace-blocked' })
// 只读会话的命令行也拒绝；宿主机桌面操作 / 设置一律拒绝
assert.deepEqual(guard.judgeBody('/api/commands/execute', JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'commands/execute', payload: { args: { agentId: 'sess-work', line: '/help' } } })), { deny: 'workspace-readonly' })
assert.deepEqual(guard.judgeBody('/api/settings/update', JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'settings/update', payload: { args: { ns: 'theme', patch: {} } } })), { deny: 'host-only' })
assert.deepEqual(guard.judgeBody('/api/session/openWorkspacePath', JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/openWorkspacePath', payload: { args: { request: { path: 'C:\\\\work' } } } })), { deny: 'host-only' })
// 终端的流直接不给房客开
assert.equal(guard.clientFrame({ type: 'open', streamId: 't1', endpoint: 'terminal/attach', payload: { args: {} } }), null)
assert.ok(guard.clientFrame({ type: 'open', streamId: 't2', endpoint: 'session/follow', payload: { args: {} } }))

/* ── 6. session/list 响应按 cwd 过滤 ── */
const listBody = JSON.stringify({
  type: 'server-response',
  rpcId: 'r1',
  result: { ok: true, value: { items: [
    { sessionId: 'a', cwd: blockedRoot + '\\p' },
    { sessionId: 'b', cwd: allowedRoot + '\\q' },
    { sessionId: 'c', projections: { asOfSeq: 1, values: { workingDirectory: blockedRoot } } },
    { sessionId: 'd', cwd: allowedRoot },
  ] } },
})
const filteredList = JSON.parse(guard.filterResponse('/api/session/list', listBody))
assert.deepEqual(filteredList.result.value.items.map((item) => item.sessionId), ['b', 'd'])
assert.equal(guard.filterResponse('/api/other', listBody), null)

/* ── 7. 帧编解码：掩码帧 → 过滤 → 重新掩码，多帧同包 ── */
function maskedFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length
  const out = Buffer.alloc(2 + 4 + length)
  out[0] = 0x81
  out[1] = 0x80 | length
  const mask = Buffer.from([1, 2, 3, 4])
  mask.copy(out, 2)
  for (let i = 0; i < length; i += 1) out[6 + i] = payload[i] ^ mask[i & 3]
  return out
}
function unmaskedFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const out = Buffer.alloc(2 + payload.length)
  out[0] = 0x81
  out[1] = payload.length
  payload.copy(out, 2)
  return out
}
function parseFrames(buffer) {
  const texts = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const b1 = buffer[offset + 1]
    let length = b1 & 0x7f
    let start = offset + 2
    if (length === 126) { length = buffer.readUInt16BE(offset + 2); start = offset + 4 }
    const masked = (b1 & 0x80) !== 0
    let mask = null
    if (masked) { mask = buffer.slice(start, start + 4); start += 4 }
    const payload = Buffer.from(buffer.slice(start, start + length))
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3]
    texts.push(payload.toString('utf8'))
    offset = start + length
  }
  return texts
}
const seen = []
const transformer = createFrameTransformer({
  masked: true,
  onText(text) {
    seen.push(text)
    const frame = JSON.parse(text)
    if (frame.type === 'open' && frame.endpoint === 'blocked') return null
    if (frame.type === 'open') return JSON.stringify(Object.assign({}, frame, { endpoint: 'rewritten' }))
    return undefined
  },
})
const chunk = Buffer.concat([
  maskedFrame(JSON.stringify({ type: 'open', streamId: '1', endpoint: 'blocked', payload: { args: {} } })),
  maskedFrame(JSON.stringify({ type: 'open', streamId: '2', endpoint: 'keep', payload: { args: {} } })),
])
const outChunk = transformer.push(chunk)
const outTexts = parseFrames(outChunk)
assert.equal(outTexts.length, 1, 'dropped frame must not be forwarded')
assert.equal(JSON.parse(outTexts[0]).endpoint, 'rewritten')
assert.equal(seen.length, 2)

// 未掩码方向（服务端→客户端）同样工作
const serverTransformer = createFrameTransformer({
  masked: false,
  onText(text) {
    const frame = JSON.parse(text)
    return frame.drop ? null : undefined
  },
})
const kept = serverTransformer.push(Buffer.concat([
  unmaskedFrame(JSON.stringify({ type: 'item', streamId: '1', value: {} })),
  unmaskedFrame(JSON.stringify({ type: 'item', streamId: '2', drop: true, value: {} })),
]))
assert.equal(parseFrames(kept).length, 1)

console.log('dsh-room guard test: PASS')
