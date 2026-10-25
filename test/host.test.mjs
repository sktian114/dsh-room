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
import { mkdtempSync, readFileSync } from 'node:fs'
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
const promptBodies = []
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
  if (url.pathname === '/api/session/prompt') {
    // 代理转发上去的 prompt 正文：房客的指令到底有没有打「谁说的」标记，就看这里。
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      promptBodies.push({
        body: Buffer.concat(chunks).toString('utf8'),
        cookie: String(req.headers.cookie || ''),
        token: url.searchParams.get('token') || '',
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }))
    })
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
// 假的 DSH agent 句柄：模拟「哪些会话还活着」，并记录投递到它们收件箱的调用。
const liveAgents = new Map()
function makeAgent(id) {
  const record = { id, calls: [] }
  record.inject = (payload) => record.calls.push({ how: 'inject', payload })
  record.followup = (payload) => record.calls.push({ how: 'followup', payload })
  record.steer = (payload) => record.calls.push({ how: 'steer', payload })
  return record
}
const agentRegistry = {
  get(id) { return liveAgents.get(String(id)) || undefined },
  list() { return [...liveAgents.values()] },
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
  agents: agentRegistry,
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
// 地址标签只用「虚拟内网 / 局域网 / WARP / 虚拟网卡」这几种通用说法，不绑定任何具体组网产品。
assert.ok(Array.isArray(started.json.urls), 'start 要给出可加入的地址')
for (const item of started.json.urls) {
  assert.ok(['虚拟内网', '局域网', 'WARP', '虚拟网卡'].includes(item.label), '地址标签要用通用说法：' + item.label)
  assert.equal(/蒲公英|oray|pgy/i.test(item.label), false, '标签里不能出现具体产品名')
}

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

/** 经房间代理转进来的房客会带 x-forwarded-for；房主本机直连不带。 */
const GUEST_HEADERS = { 'x-forwarded-for': '203.0.113.7' }

function httpPostJson(url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {})
    const request = httpRequest(url, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, extraHeaders || {}),
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
const join = await httpPostJson(roomBase + '/room/api/join', { name: '阿伟', code: '' }, GUEST_HEADERS)
console.log('join status', join.status, join.headers)
assert.equal(join.status, 200)
assert.equal(join.json.ok, true)
assert.ok(join.json.token)
assert.equal(join.json.room.name, '测试房')
assert.equal(join.json.members.length >= 1, true)
// 4.0 加入时下发房间令牌 cookie：房客页打 /api/session/prompt 时只有 cookie 能带上身份，
//     会话里的「谁说的」标记就靠它（见 4.9）。
const joinCookie = String(join.headers['set-cookie'] || '')
assert.match(joinCookie, /dsh_room_token=/)
assert.match(joinCookie, new RegExp('dsh_room_token=' + join.json.token))
// 4.0 默认封锁：房客响应里不能出现任何工作区目录名 / 路径
assert.equal(join.json.room.workspace, '')
assert.equal(join.json.room.workspaceMode, 'blocked')
assert.equal(join.json.workspace.available, false)
assert.equal(join.json.workspace.root, undefined)
assert.equal(join.json.workspace.name, '')
assert.deepEqual(join.json.workspaces, [])

// 4.0.0 房主本机直连不允许以访客身份加入自己的房间（服务端 403 host-cannot-join）。
// 注意：这条在测试里覆盖不了 —— 测试客户端会统一给请求盖 x-forwarded-for（模拟房间代理），
// isDirectHost 因此恒为 false。判定逻辑本身在真机上用 CDP 验证（房主浏览器打开房间地址应被拒）。
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

// 0.3.10：拉人/踢人要写清「谁干的」（执行人）。不传 actor 时按房主算。
const addWithActor = await post(
  '/room/api/host/chat/member',
  { group: groupId, agentId: 'session-other', agentTitle: '别的助手', actor: '房主 PC-1' },
  base,
)
assert.equal(addWithActor.status, 200)
const actorSync = await httpGetJson(roomBase + '/room/api/chat/sync?token=' + guestToken + '&since=0')
const actorNotice = actorSync.body.messages.filter((m) => m.group === groupId && m.from.kind === 'system').map((m) => m.text)
assert.ok(actorNotice.some((t) => t.includes('房主 PC-1 把') && t.includes('拉进了')), '系统提示要带执行人：' + actorNotice.join(' | '))
assert.ok(actorNotice.some((t) => t.startsWith('房主 把')), '不传 actor 时按「房主」算：' + actorNotice.join(' | '))
// 移出同样要写执行人
const removed = await post(
  '/room/api/host/chat/member',
  { group: groupId, agentId: 'session-other', remove: true, actor: '房主 PC-1' },
  base,
)
assert.equal(removed.status, 200)
const afterRemove = await httpGetJson(roomBase + '/room/api/chat/sync?token=' + guestToken + '&since=0')
assert.ok(
  afterRemove.body.messages.some((m) => m.from.kind === 'system' && m.text.includes('房主 PC-1 把') && m.text.includes('移出了')),
  '移出也要写执行人',
)

// 0.3.10：建群可以只拉指定的人（不传 = 空群），不需要把整个工作区的 agent 都塞进来
const pickedGroup = await post('/room/api/host/chat/group', { name: '只拉一个', agents: [{ id: 'session-test' }] }, base)
assert.equal(pickedGroup.status, 200)
assert.equal(pickedGroup.json.group.agents.length, 1, '只应拉进勾中的那一个')
assert.equal(pickedGroup.json.added.length, 1)
const emptyGroup = await post('/room/api/host/chat/group', { name: '空空如也' }, base)
assert.equal(emptyGroup.status, 200)
assert.equal(emptyGroup.json.group.agents.length, 0, '不选人就是空群')

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

// 8.7 群消息投递（P0）：新消息静默进 agent 收件箱，点名的才唤醒
console.log('step: chat-push')
assert.equal(typeof addAgent.json.group.agents[0].alias, 'string', '每个 agent 要有唯一别名')
const refactorAgent = makeAgent('session-test')
liveAgents.set('session-test', refactorAgent)
const pushSend = await httpPostJson(roomBase + '/room/api/chat/send?token=' + guestToken, { group: groupId, text: '给 agent 的活' })
assert.equal(pushSend.status, 200)
assert.equal(pushSend.json.pushed.delivered, 1, '在线 agent 应收到一次静默投递')
assert.equal(pushSend.json.pushed.woke, 0, '没点名就不该唤醒')
assert.equal(refactorAgent.calls.length, 1)
assert.equal(refactorAgent.calls[0].how, 'inject', '默认走 inject（不唤醒、不烧额度）')
const pushedText = refactorAgent.calls[0].payload.content[0].text
assert.ok(pushedText.includes('给 agent 的活'), '投递正文里要有消息内容')
assert.ok(pushedText.includes('room_chat_read'), '投递正文要告诉它怎么读')
// 0.3.10：推送正文最前面要有 `〔@发信人〕` 标记 —— 会话里靠它画「作者胶囊」，
// 而且标记是**落在会话日志里的纯文本**，所以重启之后历史消息的胶囊还在。
assert.ok(pushedText.startsWith('〔@'), '推送正文要以作者标记开头：' + pushedText.slice(0, 40))
assert.ok(/^〔@[^〕\n]{1,40}〕/.test(pushedText), '标记格式要能被客户端正则认出来')
// source.kind 必须是 producer-owned 形态：`{kind:'plugin'}` 是 DSH v4 已退役写法，
// 落盘会被拒（真机上表现为「本轮运行失败：format v4 message requires a producer-owned source kind」）。
const pushedSource = refactorAgent.calls[0].payload.source
assert.equal(pushedSource.kind, 'plugin:@sktian114/dsh-room')
assert.notEqual(pushedSource.kind, 'plugin', '退役的 plugin 包装会被 DSH 拒收')
assert.equal('plugin' in pushedSource, false, '不能带 plugin 字段（那是 v3 的写法）')
// 载荷还必须是 DSH 的**完整消息**形态：dsh-agent-loop 的 step() 直接把它当
// user/message 的 data 落盘（不会补 role/id）。缺了会写出过不了校验的会话日志，
// 下次加载整体报「session event at seq N lacks an identified message」，会话打不开。
// 真机事故：session-bb816161 / session-c555cd98 因此损坏（2026-10-24）。
const pushedPayload = refactorAgent.calls[0].payload
assert.equal(pushedPayload.role, 'user', '载荷必须有 role:"user"')
assert.equal(typeof pushedPayload.id, 'string', '载荷必须有字符串 id')
assert.ok(pushedPayload.id.length > 0, 'id 不能为空')

// 同一条消息不会重复投递：游标推进后再发新消息只推新的那条
const secondSend = await httpPostJson(roomBase + '/room/api/chat/send?token=' + guestToken, { group: groupId, text: '第二条' })
assert.equal(secondSend.json.pushed.delivered, 1)
assert.equal(refactorAgent.calls.length, 2)

// 点名（用别名）→ followup 唤醒，而不是静默 inject
const alias = addAgent.json.group.agents[0].alias
const wake = await httpPostJson(roomBase + '/room/api/chat/send?token=' + guestToken, { group: groupId, text: '来帮忙 @' + alias })
assert.equal(wake.json.pushed.woke, 1, '点名要唤醒')
assert.equal(wake.json.mentions.includes('session-test'), true)
assert.equal(refactorAgent.calls.at(-1).how, 'followup', '点名走 followup')
// 唤醒路径的载荷同样必须具备 role/id，否则被唤醒的会话会被写坏
const wokePayload = refactorAgent.calls.at(-1).payload
assert.equal(wokePayload.role, 'user', '点名唤醒的载荷必须有 role:"user"')
assert.ok(typeof wokePayload.id === 'string' && wokePayload.id.length > 0, '点名唤醒的载荷必须有 id')

// 离线会话（注册表里没有）跳过，不影响其它人收到
liveAgents.delete('session-test')
const offlineSend = await httpPostJson(roomBase + '/room/api/chat/send?token=' + guestToken, { group: groupId, text: '没人在吗' })
assert.equal(offlineSend.status, 200)
assert.equal(offlineSend.json.pushed.delivered, 0)
assert.equal(offlineSend.json.pushed.skipped, 1, '离线会话记为跳过')

// 重复拉同一个会话是幂等的：不报错、不刷系统提示
const dupAgent = await post('/room/api/host/chat/member', { group: groupId, agentId: 'session-test', agentTitle: '重构助手' }, base)
assert.equal(dupAgent.status, 200)
assert.equal(dupAgent.json.already, true)

// 房主「召唤」：显式唤醒；不存在的成员按 not-member 拒绝
liveAgents.set('session-test', makeAgent('session-test'))
const woke = await post('/room/api/host/chat/wake', { group: groupId, agentId: 'session-test' }, base)
assert.equal(woke.status, 200)
assert.equal(liveAgents.get('session-test').calls.at(-1).how, 'followup', '召唤要唤醒')
// 房主召唤走的是另一处 followup，同样要求完整消息形态
const summonPayload = liveAgents.get('session-test').calls.at(-1).payload
assert.equal(summonPayload.role, 'user', '召唤的载荷必须有 role:"user"')
assert.ok(typeof summonPayload.id === 'string' && summonPayload.id.length > 0, '召唤的载荷必须有 id')
const wakeMissing = await post('/room/api/host/chat/wake', { group: groupId, agentId: 'session-nobody' }, base)
assert.equal(wakeMissing.status, 400)

// 工具侧：read 会把未读游标推到最新，并把 since 当游标用
const readDef2 = registeredTools.get('room_chat_read')
const memberExec = { agent: { session: { id: 'session-test', title: '重构助手' } } }
const readBack = await readDef2.execute({ group: groupId, since: 0, limit: 50 }, memberExec)
assert.equal(readBack.ok, true)
assert.ok(readBack.messages.length > 0)
assert.equal(readBack.cursor, readBack.messages[readBack.messages.length - 1].seq, '读完游标推到最新')
const readAgain = await readDef2.execute({ group: groupId }, memberExec)
assert.equal(readAgain.messages.length, 0, '没有新消息时再读是空的')
assert.equal(readAgain.since, readBack.cursor)
// 工具侧点名：to 参数唤醒 + 返回 pushed 统计
liveAgents.set('session-helper', makeAgent('session-helper'))
const addHelper = await post('/room/api/host/chat/member', { group: groupId, agentId: 'session-helper', agentTitle: '小助手' }, base)
const helperAlias = addHelper.json.group.agents.find((item) => item.id === 'session-helper').alias
const postDef2 = registeredTools.get('room_chat_post')
const toolPost = await postDef2.execute({ group: groupId, text: '点名了', to: [helperAlias] }, memberExec)
assert.equal(toolPost.ok, true)
assert.equal(toolPost.mentions.includes('session-helper'), true)
assert.equal(toolPost.pushed.woke, 1)
assert.equal(liveAgents.get('session-helper').calls.at(-1).how, 'followup')
// 没被拉进群的人读不到
const outsiderRead = await readDef2.execute({ group: groupId }, { agent: { session: { id: 'session-outsider', title: '局外人' } } })
assert.equal(outsiderRead.ok, false)
assert.equal(outsiderRead.error, 'not-member')

// 注册表只认内部 id 形态、get() 取不到时，靠 list() 兜住（不能「明明在跑却说会话不在」）
liveAgents.set('session-test', makeAgent('session-test'))
const realGet = agentRegistry.get
agentRegistry.get = () => undefined
const viaList = await httpPostJson(roomBase + '/room/api/chat/send?token=' + guestToken, { group: groupId, text: 'get 取不到也要能投' })
assert.equal(viaList.json.pushed.skipped, 0, 'get 落空时要按 list 兜住')
assert.ok(viaList.json.pushed.delivered + viaList.json.pushed.woke >= 1)
agentRegistry.get = realGet

// 休眠会话被点名：先让 DSH 把会话恢复出来（resolveAgent），再 followup —— 这是真机上
// 「重启后会话都没在跑，@它没反应」的正解。
liveAgents.delete('session-test')
let resumed = 0
const revived = makeAgent('session-test')
agentRegistry.resolveAgent = async (id) => {
  if (String(id) !== 'session-test') return { error: { code: 'session/not-found' } }
  resumed += 1
  liveAgents.set('session-test', revived)
  return revived
}
const dormantWake = await httpPostJson(roomBase + '/room/api/chat/send?token=' + guestToken, {
  group: groupId,
  text: '醒醒 @' + alias,
})
assert.equal(dormantWake.json.pushed.woke, 1, '点名休眠会话要恢复 + 唤醒')
assert.equal(resumed, 1, '只对点名的那个会话做恢复')
assert.equal(revived.calls.at(-1).how, 'followup')
// 恢复不出 agent 时按跳过处理，不抛错、不影响别人收到
liveAgents.delete('session-test')
delete agentRegistry.resolveAgent
const dormantFail = await httpPostJson(roomBase + '/room/api/chat/send?token=' + guestToken, {
  group: groupId,
  text: '再点名一次 @' + alias,
})
assert.equal(dormantFail.status, 200)
assert.equal(dormantFail.json.pushed.woke, 0)
assert.ok(dormantFail.json.pushed.skipped >= 1)
liveAgents.set('session-test', makeAgent('session-test'))

// 8.6 房客昵称/头像 + 本地存档：重启后聊天记录与「谁是谁」都还在
console.log('step: persist')
const AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const profileSave = await httpPostJson(roomBase + '/room/api/profile?token=' + guestToken, { name: '阿伟', avatar: AVATAR })
assert.equal(profileSave.status, 200)
assert.equal(profileSave.json.ok, true)
assert.equal(profileSave.json.self.avatar, AVATAR, '房客头像要记到房主这边')
const stateWithAvatar = await httpGetJson(roomBase + '/room/api/state?token=' + guestToken)
assert.equal(stateWithAvatar.body.members.some((m) => m.avatar === AVATAR), true, '成员列表里带头像')
// 落盘（0.8 秒合并一次，等一下再看文件）
await new Promise((resolve) => setTimeout(resolve, 1300))
const storeFile = joinPath(process.env.DSH_HOME, 'dsh-room-store.json')
const savedStore = JSON.parse(readFileSync(storeFile, 'utf8'))
assert.equal(savedStore.version, 1)
const savedProfiles = Object.values(savedStore.members || {})
assert.ok(savedProfiles.some((m) => m.name === '阿伟' && m.avatar === AVATAR), '存档里有房客的昵称与头像')
assert.ok(savedStore.chat && Array.isArray(savedStore.chat.groups), '存档里有聊天群')
assert.ok(savedStore.chat.groups.some((g) => g.id === groupId && g.name === '前端小组'), '自建的群也存了')
assert.ok(
  savedStore.chat.groups.some((g) => (g.messages || []).some((m) => m.text === '在吗')),
  '聊天记录落盘了',
)
assert.ok((savedStore.chat.messages || savedStore.chat.recent || []).length > 0, '全局消息也存了')
// 头像只收图片：脚本/超长内容一律丢掉（前端传什么都不能变成 XSS 入口）
const badAvatar = await httpPostJson(roomBase + '/room/api/profile?token=' + guestToken, { avatar: 'javascript:alert(1)' })
assert.equal(badAvatar.json.ok, true)
assert.equal(badAvatar.json.self.avatar, '', '非图片内容不收')
const noAuthProfile = await httpPostJson(roomBase + '/room/api/profile?token=deadbeef', { avatar: AVATAR })
assert.equal(noAuthProfile.status, 401, '没令牌不能改身份')

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
assert.deepEqual([...registeredTools.keys()].sort(), [
  'room_chat_invite',
  'room_chat_list',
  'room_chat_members',
  'room_chat_post',
  'room_chat_read',
  'room_chat_rename',
])
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
assert.ok(roster.groups.some((group) => Array.isArray(group.agents) && group.agents.some((agent) => agent.id === 'session-test')))
// 没入群的群不该吐成员表 / 最后一条消息（2026-10-25 审计：以前任何 agent 调一次 list
// 就能看到所有群的内容与成员，违背「agent 只看被拉进的群」）
const notJoinedGroup = roster.groups.find((group) => !group.joined)
if (notJoinedGroup) {
  assert.equal(notJoinedGroup.agents, undefined, '未入群的成员表不能给')
  assert.equal(notJoinedGroup.lastText, undefined, '未入群的最后一条消息不能给')
}
const listedOutsider = await listDef.execute({}, outsiderExec)
assert.equal(listedOutsider.ok, true)
const leaking = listedOutsider.groups.filter((group) => group.joined === false && group.lastText !== undefined)
assert.equal(leaking.length, 0, '未入群的群不能返回 lastText')

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
const ownMessages = mineRead.messages.filter((message) => message.mine)
assert.ok(ownMessages.length >= 1, 'agent should recognise its own message')
assert.ok(ownMessages.some((message) => message.text === '工具发言'))

// 8.6.1 agent 自助改名：只改自己的名字；撞名自动加尾巴；不在群里就报 not-member
console.log('step: agent rename')
// 「拉进群」现在会校验会话是否真的存在（挡糊出来的假 id），先把测试用的会话登记进假注册表
for (const id of ['session-test', 'session-other', 'session-third', 'session-child', 'session-helper']) {
  if (!liveAgents.has(id)) liveAgents.set(id, makeAgent(id))
}
const renameDef = registeredTools.get('room_chat_rename')
const inviteDef = registeredTools.get('room_chat_invite')
assert.equal(typeof renameDef.output.render, 'function')
assert.equal(typeof inviteDef.output.render, 'function')
const renamed = await renameDef.execute({ group: groupId, name: '排版小工' }, agentExec)
assert.equal(renamed.ok, true)
assert.equal(renamed.renamed[0].alias, '排版小工')
const rosterAfterRename = await membersDef.execute({}, agentExec)
const selfRow = rosterAfterRename.groups.find((group) => group.id === groupId).agents.find((agent) => agent.id === 'session-test')
assert.equal(selfRow.alias, '排版小工', '改名要落到群成员上')
// 撞名：另一个人先占了同一个名字
await inviteDef.execute({ agent: 'session-other', group: groupId, name: '排版小工' }, agentExec)
const renamedAgain = await renameDef.execute({ group: groupId, name: '抓虫的' }, agentExec)
assert.equal(renamedAgain.ok, true)
assert.equal(renamedAgain.renamed[0].alias, '抓虫的')
const collide = await inviteDef.execute({ agent: 'session-third', group: groupId, name: '抓虫的' }, agentExec)
assert.ok(collide.agent.alias !== '抓虫的' && collide.agent.alias.startsWith('抓虫的'), '撞名要自动加后缀：' + collide.agent.alias)
// 不在群里的人改不了（注意：前面已经把 session-other 拉进群了，这里换个没入群的会话）
const ghostExec = { agent: { session: { id: 'session-ghost', title: '幽灵' } } }
const outsiderRename = await renameDef.execute({ group: groupId, name: '偷偷改名' }, ghostExec)
assert.equal(outsiderRename.error, 'not-member')
// 空名字拒绝
assert.equal((await renameDef.execute({ group: groupId, name: '   ' }, agentExec)).error, 'bad-name')

// 8.6.2 主 agent 把子 agent 拉进自己所在的群，并顺手给它起名
const invited = await inviteDef.execute({ agent: 'session-child', name: '小工一号' }, agentExec)
assert.equal(invited.ok, true)
assert.equal(invited.group, groupId, '不传群就用自己所在的群')
assert.equal(invited.agent.alias, '小工一号')
assert.equal(invited.already, false)
// 幂等：再拉一次不产生系统事件
const invitedAgain = await inviteDef.execute({ agent: 'session-child', name: '小工一号' }, agentExec)
assert.equal(invitedAgain.already, true)
// 局外人不能往自己不在的群里拉人
const outsiderInvite = await inviteDef.execute({ agent: 'session-child', group: groupId }, ghostExec)
assert.equal(outsiderInvite.error, 'not-member')
// 缺 agent 参数 → bad-agent
assert.equal((await inviteDef.execute({}, agentExec)).error, 'bad-agent')
// 糊一个不存在的会话 id → unknown-agent（真机踩过：全零 UUID 也能进群，群里多出永远不说话的影子成员）
const bogus = await inviteDef.execute({ agent: 'session-00000000-0000-0000-0000-000000000000', group: groupId }, agentExec)
assert.equal(bogus.error, 'unknown-agent')
assert.equal(bogus.ok, false)

// 同一个名字 + 同一个来源 IP 重连 → 身份 id 不变（聊天记录里的「谁说的」不会断）
// 注意：重连会换发新令牌、旧令牌作废，所以这条放在所有「用旧令牌」的断言之后。
const rejoin = await httpPostJson(roomBase + '/room/api/join', { name: '阿伟' }, GUEST_HEADERS)
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
const ghost = await httpPostJson(roomBase + '/room/api/join', { name: '幽灵访客' }, GUEST_HEADERS)
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

// 8.7 房主专用接口的统一闸门（2026-10-25 补的洞）
// 以前每个 handler 自己记得写 isDirectHost()，结果 policy / fs / start / stop / kick
// 五条漏了 —— 房客带着 x-forwarded-for 走代理就能读到工作区策略、列任意目录、把房间停掉。
// 现在路由匹配之前统一挡；这里逐条钉住，防止以后新加的 host 路由又漏。
console.log('step: host-gate')
const guestHostRoutes = [
  ['GET', '/room/api/host/policy'],
  ['POST', '/room/api/host/policy'],
  ['GET', '/room/api/host/state'],
  ['GET', '/room/api/host/agents'],
  ['GET', '/room/api/host/fs?path=' + encodeURIComponent(process.cwd())],
  ['POST', '/room/api/host/start'],
  ['POST', '/room/api/host/stop'],
  ['POST', '/room/api/host/kick'],
  ['POST', '/room/api/host/chat/group'],
  ['POST', '/room/api/host/chat/member'],
  ['POST', '/room/api/host/chat/wake'],
]
for (const [method, route] of guestHostRoutes) {
  const response = await httpPostJson(roomBase + route, {}, GUEST_HEADERS)
  assert.equal(response.status, 403, '房客不该能打 ' + method + ' ' + route + '（拿到 ' + response.status + '）')
  assert.equal(response.json && response.json.error, 'host-only', route + ' 的错误码要是 host-only')
}
// 重点：stop 没被执行（否则后面的断言和房间状态都会变）
const stillRunning = await httpGetJson(base + '/room/api/host/state')
assert.equal(stillRunning.body.running, true, '房客的 stop 请求不能真的把房间停掉')
// 房主本机直连照旧能用（不能把闸门做成「谁都进不来」）
const hostPolicy = await httpGetJson(base + '/room/api/host/policy')
assert.equal(hostPolicy.status, 200, '房主直连要能读策略')

// 9. 停止（必须是本机直连；房客走代理会被 host-only 拦掉）
const stopped = await post('/room/api/host/stop', {}, base)
assert.equal(stopped.json.running, false)

await dispose()
fake.close()
console.log('dsh-room host smoke test: PASS')
