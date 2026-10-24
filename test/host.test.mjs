/**
 * dsh-room 宿主侧冒烟测试（不依赖 DSH，直接跑 Node）
 *
 *   node test/host.test.mjs
 *
 * 用一个假的 DSH 上游验证：
 *   · /room/api/host/start 能拉起 8787 代理
 *   · 首页导航被补 token，并把 303 的绝对 Location 改写回房间地址
 *   · Host / Origin 被改写成 loopback
 *   · 加入 / 成员 / 工作区列表
 *   · WebSocket upgrade 透传
 */
import { createServer, request as httpRequest, get as httpGet } from 'node:http'
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'

// 策略会落盘到 $DSH_HOME/dsh-room-policy.json：测试必须用临时目录，别碰真实配置。
process.env.DSH_HOME = mkdtempSync(joinPath(tmpdir(), 'dsh-room-test-'))

import { apply } from '../index.mjs'

process.on('uncaughtException', (error) => { console.error('UNCAUGHT', error); process.exit(1) })
process.on('unhandledRejection', (error) => { console.error('UNHANDLED', error); process.exit(1) })
const hardTimeout = setTimeout(() => { console.error('TEST TIMEOUT'); process.exit(2) }, 25000)
hardTimeout.unref()

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try { resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }) }
        catch { resolve({ status: response.statusCode, headers: response.headers, text }) }
      })
    })
    request.on('error', reject)
    request.setTimeout(4000, () => request.destroy(new Error('timeout')))
  })
}

const ROOM_PORT = 18787

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

let route = null
const seen = []
const fake = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/room' || url.pathname.startsWith('/room/')) {
    if (!route) { res.writeHead(503); res.end('no-route'); return }
    route.handler(req, res)
    return
  }
  seen.push({ path: url.pathname, headers: req.headers })
  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (url.searchParams.get('token') === 'test-token') {
      res.writeHead(303, {
        location: 'http://127.0.0.1:' + fake.address().port + '/',
        'set-cookie': 'dsh_session=ok; Path=/; Domain=127.0.0.1; Secure; HttpOnly',
      })
      res.end()
      return
    }
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('unauthorized')
    return
  }
  if (url.pathname === '/api/echo') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      host: req.headers.host,
      origin: req.headers.origin,
      cookie: req.headers.cookie || '',
    }))
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('nope')
})

fake.on('upgrade', (req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  socket.on('data', (chunk) => socket.write('echo:' + chunk.toString()))
  socket.on('error', () => {})
})

const fakePort = await listen(fake)
let dispose = null
// 复刻 DSH 的 tools.register 硬校验：output 缺 render 就抛 TypeError。
// 真实的 DSH 会把这个异常当成插件加载失败 → 整个 DSH 起不来（我们踩过一次）。
const registeredTools = new Map()
const fakeTools = {
  register(definition) {
    const name = (definition && definition.name) || '(unnamed)'
    const output = definition && definition.output
    if (output === undefined || typeof output !== 'object' || typeof output.render !== 'function') {
      throw new TypeError('tool "' + name + '" must declare output { schema, render, presentationMeta? }')
    }
    if (!definition.parameters || typeof definition.parameters !== 'object') {
      throw new TypeError('tool "' + name + '" must declare a parameters schema object')
    }
    if (typeof definition.execute !== 'function') {
      throw new TypeError('tool "' + name + '" must declare execute')
    }
    registeredTools.set(name, definition)
    return () => { registeredTools.delete(name) }
  },
}
const ctx = {
  logger: () => ({ info() {}, warn() {}, error() {} }),
  webServer: {
    port: fakePort,
    register(spec) { route = spec; return () => { route = null } },
  },
  connection: {
    authenticatedUrl(base) { return base + '/?token=test-token' },
  },
  tools: fakeTools,
  effect(fn) { dispose = fn() },
  get() { return null },
}

apply(ctx, { port: ROOM_PORT, name: '测试房', workspace: process.cwd() })
assert.ok(route, 'route registered')
assert.ok(dispose, 'dispose registered')

const base = 'http://127.0.0.1:' + fakePort
const roomBase = 'http://127.0.0.1:' + ROOM_PORT

async function post(path, body, target) {
  const response = await fetch((target || roomBase) + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  return { status: response.status, json: await response.json() }
}

const started = await post('/room/api/host/start', { port: ROOM_PORT, name: '测试房', workspace: process.cwd() }, base)
assert.equal(started.status, 200, 'start status ' + started.status)
assert.equal(started.json.ok, true)
assert.equal(started.json.room.port, ROOM_PORT)

// 0. 默认策略：工作区全部封锁，房主端能看到策略，房客端连目录名都看不到
console.log('step: policy-default')
const state0 = await httpGetJson(base + '/room/api/host/state')
assert.equal(state0.body.policy.defaultMode, 'blocked')
assert.equal(state0.body.roomWorkspaceMode, 'blocked')
assert.equal(state0.body.workspace.available, false, '封锁时不给工作区内容')
assert.equal(state0.body.policy.entries.length, 0)

// 1. 首页导航：补 token → 303 → Location 改回房间地址
console.log('step: home')
const home = await fetch(roomBase + '/', { redirect: 'manual', headers: { accept: 'text/html' } })
console.log('home status', home.status, home.headers.get('location'))
assert.equal(home.status, 303, 'home status ' + home.status)
assert.equal(home.headers.get('location'), roomBase + '/')
assert.match(String(home.headers.get('set-cookie')), /dsh_session=ok/)
assert.doesNotMatch(String(home.headers.get('set-cookie')), /Domain=/i)
assert.doesNotMatch(String(home.headers.get('set-cookie')), /Secure/i)
await home.text()

// 1.1 握手频控：同一来源 IP 连续握手超过上限时，给一张能重试的提示页
console.log('step: handshake-limit')
let limitedPage = null
for (let i = 0; i < 11; i += 1) {
  const response = await fetch(roomBase + '/', { redirect: 'manual', headers: { accept: 'text/html' } })
  limitedPage = { status: response.status, body: await response.text() }
}
console.log('handshake-limit last status', limitedPage.status)
assert.equal(limitedPage.status, 200)
assert.match(limitedPage.body, /没有保存登录 Cookie/)
assert.match(limitedPage.body, /重新加载/, '提示页要给手机一个可点的重试入口')
assert.match(limitedPage.body, /viewport-fit=cover/, '提示页要适配手机安全区')

// 2. 非 HTML 导航不补 token
console.log('step: no-token')
const noToken = await fetch(roomBase + '/', { redirect: 'manual', headers: { accept: 'application/json' } })
console.log('no-token status', noToken.status)
assert.equal(noToken.status, 401)
await noToken.text()

// 3. API 透传：Host / Origin 改成 loopback
console.log('step: echo')
const echo = await fetch(roomBase + '/api/echo')
const echoed = await echo.json()
assert.equal(echoed.host, '127.0.0.1:' + fakePort)
assert.equal(echoed.origin, 'http://127.0.0.1:' + fakePort)

// 3.5 房客跨源请求：原始 Origin 进 x-room-origin，CORS 回显给房客
const guestOrigin = 'http://172.16.1.130:8787'
function rawRequest(method, path, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(roomBase + path, { method, headers }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }))
    })
    request.on('error', reject)
    request.setTimeout(4000, () => request.destroy(new Error('timeout')))
    request.end()
  })
}
const corsPing = await rawRequest('GET', '/room/api/ping', { origin: guestOrigin })
assert.equal(corsPing.headers['access-control-allow-origin'], guestOrigin)
// /room/api/self：前端靠它判断「房主 or 房客」。走房间代理的一律不是房主
// （代理会给每个转发请求盖上 x-forwarded-for），房主浏览器是直连 DSH 端口的。
const selfViaProxy = await rawRequest('GET', '/room/api/self', {})
assert.equal(selfViaProxy.status, 200)
assert.equal(JSON.parse(selfViaProxy.body).host, false, '经代理进来的都算房客')
const selfGuest = await rawRequest('GET', '/room/api/self', { 'x-forwarded-for': '192.168.1.23' })
assert.equal(JSON.parse(selfGuest.body).host, false, '带 x-forwarded-for 的也是房客')
const preflight = await rawRequest('OPTIONS', '/room/api/join', {
  origin: guestOrigin,
  'access-control-request-method': 'POST',
  'access-control-request-headers': 'content-type',
  'access-control-request-private-network': 'true',
})
assert.equal(preflight.status, 204)
assert.equal(preflight.headers['access-control-allow-origin'], guestOrigin)
assert.equal(preflight.headers['access-control-allow-private-network'], 'true')

function httpPostJson(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {})
    const request = httpRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try { resolve({ status: response.statusCode, headers: response.headers, json: JSON.parse(text) }) }
        catch { resolve({ status: response.statusCode, headers: response.headers, text }) }
      })
    })
    request.on('error', reject)
    request.setTimeout(5000, () => request.destroy(new Error('timeout')))
    request.write(payload)
    request.end()
  })
}

// 4. 加入房间
console.log('step: join')
const join = await httpPostJson(roomBase + '/room/api/join', { name: '阿伟', code: '' })
console.log('join status', join.status, join.headers)
assert.equal(join.status, 200)
assert.equal(join.json.ok, true)
assert.ok(join.json.token)
assert.equal(join.json.room.name, '测试房')
assert.equal(join.json.members.length >= 1, true)
// 4.0 默认封锁：房客响应里不能出现任何工作区目录名 / 路径
assert.equal(join.json.room.workspace, '')
assert.equal(join.json.room.workspaceMode, 'blocked')
assert.equal(join.json.workspace.available, false)
assert.equal(join.json.workspace.root, undefined)
assert.equal(join.json.workspace.name, '')
assert.deepEqual(join.json.workspaces, [])

// 4.1 同一来源 IP 每分钟超过 8 次加入会被限流（房客来源由 x-forwarded-for 标识）
function joinFrom(ip) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ name: '压力测试' })
    const request = httpRequest(base + '/room/api/join', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-forwarded-for': ip,
      },
    }, (response) => {
      let text = ''
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch { json = null }
        resolve({ status: response.statusCode, json })
      })
    })
    request.on('error', reject)
    request.write(payload)
    request.end()
  })
}
let limited = null
for (let i = 0; i < 9; i += 1) limited = await joinFrom('172.16.1.99')
assert.equal(limited.status, 429, 'rate limit status')
assert.equal(limited.json.error, 'too-many-attempts')

// 4.2 房主单独开放房间工作区（只读）：房客能看到，但权限是 readonly
console.log('step: policy-open-readonly')
const opened = await post('/room/api/host/policy', {
  defaultMode: 'blocked',
  entries: [{ path: process.cwd(), mode: 'readonly' }],
}, base)
assert.equal(opened.status, 200)
assert.equal(opened.json.policy.entries.length, 1)
const stateOpened = await httpGetJson(base + '/room/api/host/state')
assert.equal(stateOpened.body.roomWorkspaceMode, 'readonly')
const guestOpened = await httpGetJson(roomBase + '/room/api/state?token=' + encodeURIComponent(join.json.token))
assert.equal(guestOpened.body.workspace.available, true)
assert.equal(guestOpened.body.workspace.mode, 'readonly')
assert.equal(guestOpened.body.room.workspaceMode, 'readonly')
assert.equal(typeof guestOpened.body.workspace.root, 'string')

// 4.3 单独封锁工作区里的子文件夹：名字在文件树里消失，列目录被拒
console.log('step: policy-block-folder')
const folder = joinPath(process.cwd(), 'test')
const blockedPolicy = await post('/room/api/host/policy', {
  defaultMode: 'blocked',
  entries: [
    { path: process.cwd(), mode: 'readonly' },
    { path: folder, mode: 'blocked' },
  ],
}, base)
assert.equal(blockedPolicy.status, 200)
const folderGuest = await httpGetJson(roomBase + '/room/api/state?token=' + encodeURIComponent(join.json.token))
assert.equal(folderGuest.body.workspace.entries.some((entry) => entry.name === 'test'), false, '被封锁的子文件夹不能出现在文件树里')
const deniedFolder = await fetch(roomBase + '/room/api/list?path=test&token=' + encodeURIComponent(join.json.token))
const deniedFolderJson = await deniedFolder.json()
assert.equal(deniedFolder.status, 403)
assert.equal(deniedFolderJson.error, 'workspace-blocked')

// 4.4 房主端文件夹选择器：能看到路径与解析后的权限
console.log('step: policy-fs')
const fsList = await httpGetJson(base + '/room/api/host/fs?path=' + encodeURIComponent(process.cwd()))
assert.equal(fsList.status, 200)
const testEntry = fsList.body.entries.find((entry) => entry.name === 'test')
assert.ok(testEntry, 'fs 列表里应该有 test 目录')
assert.equal(testEntry.mode, 'blocked')
assert.equal(testEntry.path.endsWith('test'), true)

// 5. 成员状态
console.log('step: state')
const state = await fetch(roomBase + '/room/api/state?token=' + encodeURIComponent(join.json.token))
const stateJson = await state.json()
assert.equal(stateJson.ok, true)
assert.equal(stateJson.members.some((m) => m.name === '阿伟'), true)
assert.equal(stateJson.members.some((m) => m.kind === 'host'), true)

// 5.1 心跳：一次带回 room/members/workspace；失效令牌返回 401 + stale（客户端据此自动重入）
console.log('step: heartbeat')
const beat = await fetch(roomBase + '/room/api/heartbeat?token=' + encodeURIComponent(join.json.token), { method: 'POST' })
const beatJson = await beat.json()
assert.equal(beat.status, 200)
assert.equal(beatJson.ok, true)
assert.equal(beatJson.room.name, '测试房')
assert.equal(beatJson.members.some((m) => m.name === '阿伟'), true)
assert.equal(typeof beatJson.workspace.root, 'string')
const stale = await fetch(roomBase + '/room/api/heartbeat?token=deadbeef', { method: 'POST' })
const staleJson = await stale.json()
assert.equal(stale.status, 401)
assert.equal(staleJson.stale, true, '失效令牌要能让客户端识别出来')

// 6. 工作区列表
console.log('step: list')
const net = await import('node:net')
const rawDump = await new Promise((resolve, reject) => {
  const socket = net.connect(ROOM_PORT, '127.0.0.1', () => {
    socket.write('GET /room/api/list?path=&token=' + join.json.token + ' HTTP/1.1\r\nHost: 127.0.0.1:' + ROOM_PORT + '\r\nConnection: close\r\n\r\n')
  })
  let text = ''
  socket.on('data', (chunk) => { text += chunk.toString('latin1') })
  socket.on('end', () => resolve(text))
  socket.on('error', reject)
  socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('dump timeout')) })
})
console.log('raw tail:', JSON.stringify(rawDump.slice(-60)))
console.log('chunk terminator:', rawDump.endsWith('0\r\n\r\n'))
const listResult = await fetch(roomBase + '/room/api/list?path=&token=' + encodeURIComponent(join.json.token))
const listJson = await listResult.json()
assert.equal(listJson.ok, true)
assert.equal(Array.isArray(listJson.entries), true)
assert.equal(listJson.entries.some((entry) => entry.name === 'index.mjs'), true)

// 7. 未授权列表
const denied = await fetch(roomBase + '/room/api/list?path=')
assert.equal(denied.status, 401)
await denied.text()

// 7.1 失效令牌查状态：同样要带 stale，客户端才知道该重新入房
const staleState = await fetch(roomBase + '/room/api/state?token=deadbeef')
const staleStateJson = await staleState.json()
assert.equal(staleState.status, 401)
assert.equal(staleStateJson.stale, true)

// 8. WebSocket upgrade 透传
await new Promise((resolve, reject) => {
  const request = httpRequest({
    host: '127.0.0.1',
    port: ROOM_PORT,
    path: '/ws',
    headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
  })
  const timer = setTimeout(() => reject(new Error('ws timeout')), 4000)
  request.on('upgrade', (response, socket) => {
    assert.equal(response.statusCode, 101, 'upgrade status')
    socket.once('data', (chunk) => {
      clearTimeout(timer)
      assert.equal(chunk.toString(), 'echo:hello')
      socket.destroy()
      resolve()
    })
    socket.write('hello')
  })
  request.on('error', (error) => { clearTimeout(timer); reject(error) })
  request.end()
})

// 8.5 房间聊天群：人发消息、房主建群拉 agent、房客越权被拒
console.log('step: chat')
const guestToken = encodeURIComponent(join.json.token)
const chatSend = await httpPostJson(roomBase + '/room/api/chat/send?token=' + guestToken, { group: 'lobby', text: '大家好' })
assert.equal(chatSend.status, 200)
assert.equal(chatSend.json.ok, true)
assert.equal(typeof chatSend.json.message.seq, 'number')
assert.equal(chatSend.json.message.from.kind, 'user')
// 说话人身份是稳定 id（同一个人重连还是同一个 id），不是每次进房新生成的随机串
assert.equal(chatSend.json.message.from.id, join.json.self.id)
const firstSendSeq = chatSend.json.message.seq

const chatSync = await httpGetJson(roomBase + '/room/api/chat/sync?token=' + guestToken + '&since=0')
assert.equal(chatSync.status, 200)
assert.equal(chatSync.body.self.kind, 'user')
assert.equal(chatSync.body.groups[0].id, 'lobby')
// 进房会播一条系统提示，所以第一条不是人说的话
const joinNotice = chatSync.body.messages.find((message) => message.from.kind === 'system')
assert.ok(joinNotice, 'joining the room should post a system notice')
assert.ok(joinNotice.text.includes('阿伟'), 'system notice should name who joined')
assert.ok(chatSync.body.messages.some((message) => message.text === '大家好'))

const hostSync = await httpGetJson(base + '/room/api/chat/sync?since=0')
assert.equal(hostSync.status, 200)
assert.equal(hostSync.body.self.kind, 'host')

const madeGroup = await post('/room/api/host/chat/group', { name: '前端小组' }, base)
assert.equal(madeGroup.status, 200)
const groupId = madeGroup.json.group.id
assert.equal(madeGroup.json.groups.length, 2)

const addAgent = await post('/room/api/host/chat/member', { group: groupId, agentId: 'session-test', agentTitle: '重构助手' }, base)
assert.equal(addAgent.status, 200)
assert.equal(addAgent.json.group.agents[0].title, '重构助手')

const groupSend = await httpPostJson(roomBase + '/room/api/chat/send?token=' + guestToken, { group: groupId, text: '在吗' })
assert.ok(groupSend.json.message.seq > firstSendSeq)
const groupSendSeq = groupSend.json.message.seq
const incremental = await httpGetJson(roomBase + '/room/api/chat/sync?token=' + guestToken + '&since=' + firstSendSeq)
assert.ok(incremental.body.messages.some((m) => m.group === groupId && m.text === '在吗'))
// 拉 agent 进群也要让群里看见（系统提示）
assert.ok(
  incremental.body.messages.some((m) => m.group === groupId && m.from.kind === 'system' && m.text.includes('重构助手')),
  'adding an agent should leave a system notice in the group',
)

// 房客不能冒充房主建群（请求经过代理时带 x-forwarded-for）
const hijack = await fetch(roomBase + '/room/api/host/chat/group', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.168.1.99' },
  body: JSON.stringify({ name: '偷偷建群' }),
})
assert.equal(hijack.status, 403)
const hijackJson = await hijack.json()
assert.equal(hijackJson.error, 'host-only')

// 不存在的群发消息 → 400；空消息 → 400
const noGroup = await httpPostJson(roomBase + '/room/api/chat/send?token=' + guestToken, { group: 'nope', text: 'x' })
assert.equal(noGroup.status, 400)
assert.equal(noGroup.json.error, 'no-group')
const emptyText = await httpPostJson(roomBase + '/room/api/chat/send?token=' + guestToken, { group: 'lobby', text: '   ' })
assert.equal(emptyText.status, 400)
assert.equal(emptyText.json.error, 'empty')

// 8.6 聊天工具注册：必须是 DSH 认的形状（output.schema + output.render），
//     否则 register 抛错、DSH 直接 fatal load failure 起不来。
console.log('step: chat tools')
assert.deepEqual([...registeredTools.keys()].sort(), ['room_chat_list', 'room_chat_members', 'room_chat_post', 'room_chat_read'])
const agentExec = { agent: { session: { id: 'session-test', title: '重构助手' } } }
const outsiderExec = { agent: { session: { id: 'session-other', title: '局外人' } } }
const listDef = registeredTools.get('room_chat_list')
const membersDef = registeredTools.get('room_chat_members')
const readDef = registeredTools.get('room_chat_read')
const postDef = registeredTools.get('room_chat_post')
for (const def of [listDef, membersDef, readDef, postDef]) {
  assert.equal(typeof def.output.render, 'function')
  assert.equal(def.output.schema.type, 'object')
  const parts = def.output.render({}, { ok: true })
  assert.equal(parts[0].type, 'text')
  assert.equal(typeof parts[0].text, 'string')
  // 身份口径必须写在描述里，否则 agent 还是不会把人分清
  assert.ok(def.description.includes('同一个 id'), def.name + ' description should explain identity')
}

const listed = await listDef.execute({}, agentExec)
assert.equal(listed.ok, true)
assert.ok(listed.groups.some((group) => group.id === groupId && group.joined), 'agent should be listed as joined')

// 「谁是谁」：房主 + 访客各自的身份 id、在线状态、最近谁说过话
const roster = await membersDef.execute({}, agentExec)
assert.equal(roster.ok, true)
assert.ok(roster.people.some((person) => person.role === 'host'), 'roster should include the host')
const guestRow = roster.people.find((person) => person.role === 'guest')
assert.ok(guestRow, 'roster should include the guest')
assert.equal(guestRow.id, join.json.self.id)
assert.equal(guestRow.name, '阿伟')
assert.ok(roster.spokeRecently.some((item) => item.id === join.json.self.id), 'roster should know who spoke')
assert.ok(roster.groups.some((group) => group.agents.some((agent) => agent.id === 'session-test')))

// 没被拉进来的 agent 读不到、也发不了
const deniedRead = await readDef.execute({ group: groupId }, outsiderExec)
assert.equal(deniedRead.error, 'not-member')
const deniedPost = await postDef.execute({ group: groupId, text: '偷偷发言' }, outsiderExec)
assert.equal(deniedPost.error, 'not-member')

// 被拉进来的 agent 能读能发，房客那边会看到
const read1 = await readDef.execute({ group: groupId, since: 0 }, agentExec)
assert.ok(read1.messages.some((message) => message.text === '在吗'))
assert.ok(read1.messages.every((message) => typeof message.fromId === 'string'))
const agentPost = await postDef.execute({ group: groupId, text: '工具发言' }, agentExec)
assert.equal(agentPost.ok, true)
const afterAgent = await httpGetJson(roomBase + '/room/api/chat/sync?token=' + guestToken + '&since=' + groupSendSeq)
assert.ok(afterAgent.body.messages.some((message) => message.from.kind === 'agent' && message.text === '工具发言'))
const mineRead = await readDef.execute({ group: groupId, since: 0 }, agentExec)
assert.equal(mineRead.messages.filter((message) => message.mine).length, 1, 'agent should recognise its own message')

// 同一个名字 + 同一个来源 IP 重连 → 身份 id 不变（聊天记录里的「谁说的」不会断）
// 注意：重连会换发新令牌、旧令牌作废，所以这条放在所有「用旧令牌」的断言之后。
const rejoin = await httpPostJson(roomBase + '/room/api/join', { name: '阿伟' })
assert.equal(rejoin.status, 200)
assert.equal(rejoin.json.self.id, join.json.self.id)
assert.equal(rejoin.json.members.filter((member) => member.kind === 'guest' && member.name === '阿伟').length, 1, 'rejoin must not create a second guest')

// 8.7 agent 选择器接口：房主直连能拿到列表（上游假服务不给 session/list 时就是空数组，
//     但不能 500），房客经代理打进来必须被 403 拦掉。
console.log('step: host agents')
const agentPick = await httpGetJson(base + '/room/api/host/agents')
assert.equal(agentPick.status, 200)
assert.equal(agentPick.body.ok, true)
assert.ok(Array.isArray(agentPick.body.agents), 'agents should be an array')
const agentPickGuest = await fetch(roomBase + '/room/api/host/agents', {
  headers: { 'x-forwarded-for': '192.168.1.99' },


})
assert.equal(agentPickGuest.status, 403)
assert.equal((await agentPickGuest.json()).error, 'host-only')



// 8.5 访客关掉标签页后要自动过期：把 TTL 调短（运行时读），不再心跳就该被清掉
console.log('step: member-expiry')
const ghost = await httpPostJson(roomBase + '/room/api/join', { name: '幽灵访客' })
assert.equal(ghost.status, 200, '访客能加入')
const beforeExpiry = await httpGetJson(base + '/room/api/host/state')
assert.equal(beforeExpiry.body.members.some((m) => m.name === '幽灵访客'), true)
process.env.DSH_ROOM_MEMBER_TTL = '300'
await new Promise((resolve) => setTimeout(resolve, 900))
const afterExpiry = await httpGetJson(base + '/room/api/host/state')
assert.equal(afterExpiry.body.members.some((m) => m.name === '幽灵访客'), false, '不再动就该过期，不能永远挂着')
const deadToken = await fetch(roomBase + '/room/api/heartbeat?token=' + encodeURIComponent(ghost.json.token), { method: 'POST' })
assert.equal(deadToken.status, 401, '过期的令牌也要失效')
delete process.env.DSH_ROOM_MEMBER_TTL

// 9. 停止（必须是本机直连；房客走代理会被 host-only 拦掉）
const stopped = await post('/room/api/host/stop', {}, base)
assert.equal(stopped.json.running, false)

await dispose()
fake.close()
console.log('dsh-room host smoke test: PASS')
