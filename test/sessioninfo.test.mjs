/**
 * lib/sessioninfo.mjs 的单测：从 prompt 信封取会话 id、从会话文件头读 cwd。
 *   node test/sessioninfo.test.mjs
 *
 * 这两件事是「房客能不能发指令」的前置条件：取不到会话 id 就没法补权限，
 * 读不到 cwd 就会被判 workspace-blocked（真机症状：这个目录房主没有开放）。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zstdCompressSync } from 'node:zlib'
import { promptSessionId, cwdFromSessionFile, dshHome } from '../lib/sessioninfo.mjs'

/* ── 1. 从信封里取会话 id ── */
const envelope = (request, args) => JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/prompt', payload: { args: args === undefined ? { request } : args } })

assert.equal(promptSessionId(envelope({ sessionId: 'session-a' })), 'session-a')
assert.equal(promptSessionId(envelope({ address: { sessionId: 'session-b' } })), 'session-b')
assert.equal(promptSessionId(envelope(undefined, { sessionId: 'session-c' })), 'session-c')
assert.equal(promptSessionId(envelope(undefined, { agentId: 'session-d' })), 'session-d')
assert.equal(promptSessionId('不是 JSON'), '', '畸形请求体返回空串，不抛错')
assert.equal(promptSessionId('{}'), '')
assert.equal(promptSessionId(''), '')
assert.equal(promptSessionId(null), '')
// request.sessionId 优先于 args.sessionId
assert.equal(promptSessionId(envelope(undefined, { request: { sessionId: 'first' }, sessionId: 'second' })), 'first')

/* ── 2. 从会话文件头里读 cwd（多帧 zstd，只解头一帧） ── */
const root = mkdtempSync(join(tmpdir(), 'dsh-room-sessioninfo-'))
const sessionId = 'session-head-test'
const workspaceSlug = '--E-E~0020Download-AIWorking-dsh~0020space--'
const dir = join(root, workspaceSlug, sessionId)
mkdirSync(dir, { recursive: true })
const header = JSON.stringify({
  type: 'session',
  version: 4,
  id: sessionId,
  createdAt: 1,
  cwd: 'E:\\E Download\\AIWorking\\dsh space',
}) + '\n'
const tail = JSON.stringify({ type: 'turn/start', seq: 0, data: { turn: 1 } }) + '\n'
// 两帧：头事件一帧、后续事件一帧（真机就是多帧，只解第一帧会漏内容/误判）
const file = join(dir, 'session.v4.jsonl.zstd')
writeFileSync(file, Buffer.concat([
  zstdCompressSync(Buffer.from(header, 'utf8')),
  zstdCompressSync(Buffer.from(tail, 'utf8')),
]))

assert.equal(cwdFromSessionFile(sessionId, root), 'E:\\E Download\\AIWorking\\dsh space', 'JSON 转义要还原成正常路径')
assert.equal(cwdFromSessionFile('session-not-there', root), '', '查不到返回空串')
assert.equal(cwdFromSessionFile('', root), '')

// 坏字节也不能抛错
const brokenDir = join(root, workspaceSlug, 'session-broken')
mkdirSync(brokenDir, { recursive: true })
writeFileSync(join(brokenDir, 'session.v4.jsonl.zstd'), Buffer.from('not-a-zstd-file', 'utf8'))
assert.doesNotThrow(() => cwdFromSessionFile('session-broken', root))

/* ── 3. DSH_HOME 覆盖（测试与多实例都靠它） ── */
process.env.DSH_HOME = root
assert.equal(dshHome(), root, 'DSH_HOME 优先')
delete process.env.DSH_HOME
assert.ok(dshHome().endsWith('.dsh'), '没有 DSH_HOME 时用 ~/.dsh')

rmSync(root, { recursive: true, force: true })
console.log('dsh-room sessioninfo test: PASS')
