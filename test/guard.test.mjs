/**
 * 房客守卫与 WS 帧过滤的单测（不依赖 DSH）：
 *   node test/guard.test.mjs
 */
import { strict as assert } from 'node:assert'
import { createGuestGuard, tokenFromCookie } from '../lib/guard.mjs'
import { createFrameTransformer } from '../lib/frames.mjs'
import { DENY_REASONS, denyBody } from '../lib/deny.mjs'

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
assert.deepEqual(guard.judgeBody('/api/session/create', createWritable), { create: { mode: 'write', path: writeRoot } })
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

/* ── 拒绝说明：房客撞墙时要看到人话，不是一句默认报错 ── */
const readonlyBody = denyBody('workspace-readonly')
assert.equal(readonlyBody.ok, false)
assert.equal(readonlyBody.error, 'workspace-readonly')
assert.equal(readonlyBody.code, 'room/readonly')
assert.ok(readonlyBody.message.includes('只读'))
assert.ok(readonlyBody.message.includes('不能向 Agent 发送指令'), '只读房客要知道自己没发送权限')
assert.equal(denyBody('workspace-blocked').code, 'room/blocked')
assert.equal(denyBody('host-only').code, 'room/host-only')
assert.equal(denyBody('permission-locked').code, 'room/permission-locked')
assert.equal(denyBody('approval-owner-only').code, 'room/approval-owner-only')
assert.equal(denyBody('payload-too-large').code, 'room/payload-too-large')
// 未登记的理由也要有个能读的兜底，而不是空字符串
const unknown = denyBody('something-new')
assert.equal(unknown.code, 'room/something-new')
assert.ok(unknown.message.includes('something-new'))
// 每条文案都要说清「为什么」和「怎么办」
for (const [reason, entry] of Object.entries(DENY_REASONS)) {
  assert.ok(entry.code.startsWith('room/'), reason + ' 的 code 要带 room/ 前缀')
  assert.ok(entry.message.length >= 12, reason + ' 的说明太短，房客看不懂')
}

/* ── 8. 权限改小要立刻生效：房客不刷新也不能继续发指令 ── */
let liveMode = 'write'
const liveGuard = createGuestGuard({
  isBlockedPath,
  modeForPath: (target) => (String(target || '').toLowerCase().startsWith(writeRoot.toLowerCase()) ? liveMode : 'blocked'),
})
liveGuard.clientFrame({ type: 'open', streamId: 'w1', endpoint: 'workspace/follow', payload: { args: {} } })
liveGuard.serverFrame({
  type: 'item',
  streamId: 'w1',
  value: { type: 'baseline', value: { items: [{ workspaceId: 'w-live', path: writeRoot, title: 'live', sessionIds: ['sess-live'] }] } },
})
const livePrompt = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/prompt', payload: { args: { request: { sessionId: 'sess-live' } } } })
assert.equal(liveGuard.judgeBody('/api/session/prompt', livePrompt), null, '可写时能发指令')
liveMode = 'readonly' // 房主在面板里改成只读
assert.deepEqual(liveGuard.judgeBody('/api/session/prompt', livePrompt), { deny: 'workspace-readonly' }, '降级后立刻拒绝，不用房客刷新')
liveMode = 'blocked' // 再改成不开放
assert.deepEqual(liveGuard.judgeBody('/api/session/prompt', livePrompt), { deny: 'workspace-blocked' })
liveMode = 'write' // 再放开也立刻恢复
assert.equal(liveGuard.judgeBody('/api/session/prompt', livePrompt), null)

/* ── 9. 房主账号 / 全局设置 / 插件 / 任意代码执行：房客一律不给 ── */
const hostOnlyPaths = [
  '/api/account/signOut',
  '/api/account/getProfile',
  '/api/credentials/set',
  '/api/settings/mutate',
  '/api/pluginManager/installBundle',
  '/api/dynamicCordisRunner/invoke',
  '/api/terminal/create',
  '/api/directoryPicker/pick',
  '/api/workspace/delete',
  '/api/job/kill',
  '/api/subagents/prompt',
  '/api/goals/create',
  '/api/schedule/update',
  '/api/speech/configure',
  '/api/userQuestions/answer',
  '/api/agentPresets/select',
]
for (const path of hostOnlyPaths) {
  assert.equal(guard.judgeRequest(path, 'POST', new URL('http://room.invalid' + path)), 'host-only', path + ' 必须挡住房客')
}
// 会话本身照常放行
assert.equal(guard.judgeRequest('/api/session/prompt', 'POST', new URL('http://room.invalid/api/session/prompt')), 'inspect-body')
assert.equal(guard.judgeRequest('/api/session/list', 'POST', new URL('http://room.invalid/api/session/list')), null)

/* ── 9.5 编码绕过：把路径编码一下也不能溜进禁区 ──
 * 上游 DSH 路由按解码后的路径分派，所以黑名单必须按解码后的再判一遍。
 * 2026-10-25 补：以前 `/api/%70luginManager/…`、`/api/session%2Fcreate` 都能绕过。
 */
const encodedCases = [
  '/api/%70luginManager/setBundleEnabled',
  '/api/pluginManager%2FsetBundleEnabled',
  '/api/%61ccount/logout',
  '/api/%74erminal/exec',
  '/api/settings%2Fupdate',
]
for (const path of encodedCases) {
  assert.equal(guard.judgeRequest(path, 'POST', new URL('http://room.invalid' + path)), 'host-only', path + ' 编码后也必须挡')
}
// 需要检查 body 的端点：编码后也要走 inspect-body，不能当普通请求直接放行
assert.equal(guard.judgeRequest('/api/session%2Fprompt', 'POST', new URL('http://room.invalid/api/session%2Fprompt')), 'inspect-body')
assert.equal(guard.judgeRequest('/api/session%2Fcreate', 'POST', new URL('http://room.invalid/api/session%2Fcreate')), 'inspect-body')
// 编码后的 body 判定同样生效（否则房客能拿编码路径去读封锁目录）
const encodedReadBlocked = JSON.stringify({
  type: 'client-request',
  rpcId: 'r1',
  method: 'workspaceFiles/read',
  payload: { args: { path: blockedRoot + '\\a.txt' } },
})
assert.deepEqual(
  guard.judgeBody('/api/workspaceFiles%2Fread', encodedReadBlocked),
  { deny: 'workspace-blocked' },
  '编码路径的读文件请求也要按路径判',
)

/* ── 10. 读文件端点按路径现判：封锁目录不给读，只读目录可以读 ── */
const readBlocked = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'workspaceFiles/read', payload: { args: { path: blockedRoot + '\\a.txt' } } })
assert.deepEqual(guard.judgeBody('/api/workspaceFiles/read', readBlocked), { deny: 'workspace-blocked' })
const readAllowed = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'workspaceFiles/read', payload: { args: { path: allowedRoot + '\\a.txt' } } })
assert.equal(guard.judgeBody('/api/workspaceFiles/read', readAllowed), null, '只读工作区里的文件可以读')

/* ── 11. 从 Cookie 头认出房客令牌（会话里「谁说的」标记靠它） ── */
assert.equal(tokenFromCookie('dsh_room_token=abc123', 'dsh_room_token'), 'abc123')
assert.equal(tokenFromCookie('a=1; dsh_room_token=abc123; b=2', 'dsh_room_token'), 'abc123')
assert.equal(tokenFromCookie('dsh_room_token=abc123; dsh_room_token=zzz', 'dsh_room_token'), 'abc123', '同名的取第一个')
assert.equal(tokenFromCookie('', 'dsh_room_token'), '')
assert.equal(tokenFromCookie('noequals', 'dsh_room_token'), '')
assert.equal(tokenFromCookie('other=1', 'dsh_room_token'), '')
assert.equal(tokenFromCookie(null, 'dsh_room_token'), '')
assert.equal(tokenFromCookie('dsh_room_token=abc', ''), '')

/* ── 12. 会话列表回执 → 记住「会话属于哪个工作区」，房客的指令才不会被误拦 ── */
const freshGuard12 = createGuestGuard({ isBlockedPath, modeForPath })
const listBody12 = JSON.stringify({ result: { value: { items: [
  { sessionId: 's-write', cwd: writeRoot },
  { sessionId: 's-blocked', cwd: blockedRoot },
] } } })
const filteredList12 = JSON.parse(freshGuard12.filterResponse('/api/session/list', listBody12))
assert.equal(filteredList12.result.value.items.length, 1, '封锁工作区的会话要从列表里滤掉')
const promptInWrite12 = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/prompt', payload: { args: { request: { sessionId: 's-write', content: [{ type: 'text', text: 'hi' }] } } } })
assert.equal(freshGuard12.judgeBody('/api/session/prompt', promptInWrite12), null, '记住工作区后房客的指令要放行')
const promptInSecret12 = JSON.stringify({ type: 'client-request', rpcId: 'r2', method: 'session/prompt', payload: { args: { request: { sessionId: 's-blocked', content: [{ type: 'text', text: 'hi' }] } } } })
assert.deepEqual(freshGuard12.judgeBody('/api/session/prompt', promptInSecret12), { deny: 'workspace-blocked' }, '封锁工作区里的会话仍然要拦')
// 连 WS 都没见过的会话（映射为空）依然按「不可判」拒绝，不猜
const promptUnknown12 = JSON.stringify({ type: 'client-request', rpcId: 'r3', method: 'session/prompt', payload: { args: { request: { sessionId: 's-never-seen', content: [{ type: 'text', text: 'hi' }] } } } })
assert.deepEqual(freshGuard12.judgeBody('/api/session/prompt', promptUnknown12), { deny: 'workspace-blocked' })

console.log('dsh-room guard test: PASS')
