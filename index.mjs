/**
 * dsh-room —— 房间联机（宿主半边）
 *
 * 目标：在蒲公英 / ZeroTier 这类“先把机器放进同一个虚拟局域网”的软件之后，
 * 房客只要在 DSH 面板里输入 `172.16.1.130:8787`，就能进入房主的房间：
 *   · 看到房间成员
 *   · 展开房主工作区的文件 / 程序列表
 *   · 一键打开房主的工作台（完整 DSH 界面，工作区就是房主的文件夹）
 *
 * 实现要点（为什么要自己写一个反代）：
 *   DSH 的 Web 服务只监听 loopback，并且 /api 上有一道 Host/Origin 信任栅栏；
 *   官方也明确拒绝绑定 0.0.0.0。房间代理监听 0.0.0.0:8787，把入站请求的
 *   Host / Origin / Referer 改写成 127.0.0.1:<dshPort>，于是栅栏永远看到 loopback。
 *   普通 HTTP 与 WebSocket upgrade 都原样透传，房客看到的界面与房主完全一致。
 *
 *   房客的浏览器没有 DSH 的会话 cookie，所以首页导航会被补上
 *   `?token=<本次进程的启动令牌>`（由 ctx.connection.authenticatedUrl 获取），
 *   让 DSH 用 303 + Set-Cookie 完成登录握手；之后依赖 cookie 即可。
 *
 * 安全边界：
 *   · 房间 = 房主本人的 shell。蒲公英网络成员默认可信；可选房间口令。
 *   · /room/api/host/* 只接受本机直连，代理会拒绝来自外部的这类请求。
 *   · 不把 DSH 的进程令牌暴露给房客：令牌只出现在代理内部发起的 303 跳转里。
 */

import { createServer, request as httpRequest } from 'node:http'
import { networkInterfaces, hostname, homedir } from 'node:os'
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { join, resolve, sep, basename } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createGuestGuard } from './lib/guard.mjs'
import { createFrameTransformer } from './lib/frames.mjs'

const NAME = 'dsh-room'
// 版本号以 package.json 为唯一来源，避免发版时两处不一致。
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
const PREFIX = '/room'
const DEFAULT_PORT = 8787
const BODY_LIMIT = 16 * 1024
// 成员多久没上报就算掉线。手机切到后台后浏览器会把定时器节流到 1 次/分钟甚至
// 整个冻结，60 秒会在「切出去看个消息」时就把人踢掉；120 秒给足缓冲，
// 真正离开页面的人靠 leave / 客户端重连兜底。
const MEMBER_TTL = 120_000
const MAX_LIST = 200
// 同一来源 IP 在窗口内最多握几次手。手机浏览器一次刷新就会重新握手（Cookie 被
// 无痕模式/隐私插件拒绝时更是每次都要），5 次/2 分钟太容易把正常房客挡在门外。
const HANDSHAKE_LIMIT = 10
const HANDSHAKE_WINDOW = 120_000

let sink = console
function say(level, message) {
  try {
    const fn = sink && (sink[level] || sink.log)
    if (typeof fn === 'function') fn.call(sink, message)
  } catch {
    try { console.log(message) } catch { /* 放弃 */ }
  }
}

/* ───────────────────────────── 通用工具 ───────────────────────────── */

function isLoopback(addr) {
  const a = String(addr || '').toLowerCase()
  return a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.')
}

function dshHome() {
  const home = process.env.DSH_HOME
  return typeof home === 'string' && home.length > 0 ? home : join(homedir(), '.dsh')
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8')
  const right = Buffer.from(String(b || ''), 'utf8')
  if (left.length !== right.length) return false
  try { return timingSafeEqual(left, right) } catch { return false }
}

function clampPort(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n) || n < 1024 || n > 65535) return fallback
  return n
}

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max)
}

function workspacesFromHome() {
  try {
    const file = join(dshHome(), 'storages', 'workspace.json')
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const table = (data && data.tables && data.tables.workspaces) || {}
    const out = []
    for (const id of Object.keys(table)) {
      const entry = table[id] || {}
      const path = String(entry.path || '')
      if (!path) continue
      out.push({
        id,
        path,
        title: String(entry.title || basename(path) || 'workspace'),
        updatedAt: String(entry.updatedAt || ''),
      })
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return out
  } catch {
    return []
  }
}

function defaultWorkspace() {
  const first = workspacesFromHome()[0]
  if (first) return first.path
  try { return process.cwd() } catch { return '.' }
}

function safeJoin(root, rel) {
  const base = resolve(root)
  const target = resolve(base, rel || '.')
  if (target !== base && !target.startsWith(base + sep)) {
    const error = new Error('outside-workspace')
    error.code = 'OUTSIDE'
    throw error
  }
  return target
}

function listDir(root, rel) {
  const abs = safeJoin(root, rel)
  const info = statSync(abs)
  if (!info.isDirectory()) {
    const error = new Error('not-a-directory')
    error.code = 'NOT_DIR'
    throw error
  }
  const entries = []
  for (const ent of readdirSync(abs, { withFileTypes: true })) {
    if (entries.length >= MAX_LIST) break
    if (ent.name === 'node_modules') continue
    let size = 0
    let mtime = 0
    try {
      const st = statSync(join(abs, ent.name))
      size = st.size
      mtime = st.mtimeMs
    } catch { /* 权限 / 断链：保留条目 */ }
    entries.push({
      name: ent.name,
      type: ent.isDirectory() ? 'dir' : 'file',
      size,
      mtime,
      path: rel ? rel.replace(/\\/g, '/') + '/' + ent.name : ent.name,
    })
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
  return entries
}

function urlsFor(port) {
  const out = []
  let table = {}
  try { table = networkInterfaces() || {} } catch { /* 忽略 */ }
  for (const name of Object.keys(table)) {
    for (const addr of table[name] || []) {
      if (!addr || addr.family !== 'IPv4' || addr.internal) continue
      const ip = String(addr.address || '')
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue
      const iface = String(name || '')
      // 排序原则：蒲公英 > 其它虚拟局域网 > 172.16/12 内网 > 物理局域网 > WARP/容器网卡。
      // WARP 的 172.16.x 地址对朋友通常不可达，必须排到后面，避免被误发。
      const pgy = /pgy|oray|蒲公英|sunlogin|花生壳/i.test(iface)
      const warp = /warp|cloudflare/i.test(iface)
      const container = /docker|veth|wsl|vmware|virtualbox|vEthernet|hyper-v/i.test(iface)
      const virtualLan = /tailscale|zerotier|radmin|hamachi|vpn|tun|tap|utun/i.test(iface)
      const cgnat = /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
      let label = '局域网'
      let priority = 3
      if (pgy) { label = '蒲公英'; priority = 0 }
      else if (warp) { label = 'WARP'; priority = 5 }
      else if (container) { label = '虚拟网卡'; priority = 6 }
      else if (virtualLan) { label = '虚拟局域网'; priority = 1 }
      else if (cgnat) { label = '蒲公英/虚拟内网'; priority = 2 }
      out.push({ ip, iface, url: 'http://' + ip + ':' + port, label, priority })
    }
  }
  out.sort((a, b) => a.priority - b.priority || a.ip.localeCompare(b.ip))
  return out
}

function corsHeaders(req) {
  // 代理会把 Origin 改写成 loopback 供信任栅栏校验，房客的真实 Origin
  // 由代理单独放进 x-room-origin；没有就退回 *（本插件不使用 cookie 凭证）。
  const origin = String(req.headers['x-room-origin'] || '*')
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '600',
    vary: 'Origin',
  }
}

function sendJson(res, status, payload, extra) {
  if (res.writableEnded) return
  const body = JSON.stringify(payload)
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }, extra || {}))
  res.end(body)
}

function sendHtml(res, status, html, extra) {
  if (res.writableEnded) return
  res.writeHead(status, Object.assign({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  }, extra || {}))
  res.end(html)
}

function readJson(req) {
  return new Promise((resolvePromise) => {
    let size = 0
    const chunks = []
    let done = false
    const finish = (value) => { if (!done) { done = true; resolvePromise(value) } }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) { finish(null); try { req.destroy() } catch { /* 忽略 */ } return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return finish({})
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { finish(null) }
    })
    req.on('error', () => finish(null))
  })
}

function cookieHasDsh(header) {
  return /(?:^|;\s*)[^;=]*dsh[^=]*=/i.test(String(header || ''))
}

/** 逐跳头必须由每一跳自己生成，不能原样转发。 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding',
  'te', 'trailer', 'proxy-authenticate', 'proxy-authorization',
])

function stripHopByHop(headers) {
  const out = {}
  for (const key of Object.keys(headers || {})) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    out[key] = headers[key]
  }
  return out
}

function rewriteReferer(value, port) {
  try {
    const url = new URL(String(value))
    return 'http://127.0.0.1:' + port + url.pathname + url.search
  } catch {
    return value
  }
}

function rewriteLocation(value, inboundHost, inboundProto, webPort) {
  if (!value || !inboundHost) return value
  try {
    const url = new URL(String(value), inboundProto + '://' + inboundHost)
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return value
    if (url.port && url.port !== String(webPort)) return value
    return inboundProto + '://' + inboundHost + url.pathname + url.search + url.hash
  } catch {
    return value
  }
}

function rewriteSetCookie(value, inboundProto) {
  const list = Array.isArray(value) ? value : [value]
  return list.map((raw) => {
    let cookie = String(raw)
    // 上游以为自己在 loopback 上：把 loopback 的 Domain 去掉，变成房客主机的 host-only cookie。
    cookie = cookie.replace(/;\s*Domain=(?:127\.0\.0\.1|localhost)\b/ig, '')
    // 房客走的是 http（蒲公英内网），Secure cookie 存不下。
    if (inboundProto === 'http') cookie = cookie.replace(/;\s*Secure\b/ig, '')
    return cookie
  })
}

function addToken(path, token) {
  try {
    const url = new URL(String(path || '/'), 'http://room.invalid')
    url.searchParams.set('token', token)
    return url.pathname + url.search
  } catch {
    return path
  }
}

/* ───────────────────────────── 桌面端提示页 ───────────────────────────── */

// 三张提示页共用一套样式：手机竖屏也要能完整读完并重试。
const NOTICE_CSS = `:root{color-scheme:dark}
html,body{min-height:100%}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;
padding:calc(16px + env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom));
background:#0f1115;color:#e6e8ee;font:15px/1.7 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
-webkit-text-size-adjust:100%}
.card{max-width:560px;width:100%;box-sizing:border-box;padding:28px 26px;border:1px solid rgba(255,255,255,.1);
border-radius:16px;background:#161922;box-shadow:0 24px 80px rgba(0,0,0,.5)}
h1{margin:0 0 12px;font-size:19px;line-height:1.4}
p{margin:10px 0;color:#aeb4c2}
code{background:#0b0d11;border:1px solid rgba(255,255,255,.08);border-radius:6px;padding:1px 6px;color:#9ad0ff}
ol{padding-left:20px;color:#aeb4c2}
b{color:#e6e8ee}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
a.btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 18px;border-radius:9px;
border:1px solid rgba(255,255,255,.16);background:#1d212b;color:#e6e8ee;font:500 14px/1 inherit;text-decoration:none}
a.btn.primary{background:#e6e8ee;color:#0f1115;border-color:transparent}
@media (max-width:430px){.card{padding:22px 18px}h1{font-size:17px}}`

const GATE_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<title>需要允许浏览器访问</title>
<style>${NOTICE_CSS}</style></head><body><div class="card">
<h1>房主需要先允许「浏览器访问」</h1>
<p>房间代理已经连通，但 DSH 宿主拒绝了来自浏览器的页面请求。这是 Desktop 版的安全开关。</p>
<ol>
<li>回到房主电脑上的 DSH Desktop；</li>
<li>打开 <b>设置 → 浏览器访问 / 远程访问</b>（不同版本名称略有差异）；</li>
<li>允许浏览器访问，或在 Desktop 的「手机/浏览器」入口里开启；</li>
<li>刷新本页。</li>
</ol>
<p>如果房主用的是 <code>dsh web</code> 命令行版，则通常不需要这一步。</p>
<div class="actions"><a class="btn primary" href="/">重新加载</a></div>
</div></body></html>`

const COOKIE_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<title>浏览器未保存登录状态</title>
<style>${NOTICE_CSS}</style></head><body><div class="card">
<h1>浏览器没有保存登录 Cookie</h1>
<p>房间代理已经替你换好了登录票据，但浏览器没有把它存下来，所以每次刷新都会重新登录。</p>
<p>常见原因：无痕 / 隐私模式、站点 Cookie 被禁用、清理类插件，或者刚刚刷新太频繁
（同一台手机 2 分钟内最多握手 10 次）。</p>
<p>允许本站 Cookie 后，<b>等 1 分钟</b>再点下面的按钮。</p>
<div class="actions"><a class="btn primary" href="/">重新加载</a></div>
</div></body></html>`

const NO_TOKEN_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<title>房间缺少登录令牌</title>
<style>${NOTICE_CSS}</style></head><body><div class="card">
<h1>房主这边拿不到登录令牌</h1>
<p>房间代理已经启动，但 DSH 宿主没有暴露 <code>connection.authenticatedUrl</code>，
所以无法替浏览器完成登录握手。</p>
<p>请让房主升级 DSH 到较新的版本；如果房主用的是命令行版，请确认启动时开启了 Web 端。</p>
<p>房客也可以让房主在 DSH 里生成一个带令牌的访问链接，手动粘贴到浏览器。</p>
<div class="actions"><a class="btn" href="/">重新加载</a></div>
</div></body></html>`

/* ───────────────────────────── 插件入口 ───────────────────────────── */

export const name = NAME
// connection 必须声明：Cordis 不会把未声明的服务挂到 ctx 上，实测不声明时
// ctx.connection 为 undefined，房客会拿不到登录令牌。webServer 同理。
export const inject = ['webServer', 'connection']

export function apply(ctx, config) {
  try {
    const dispose = setup(ctx, config || {})
    if (typeof dispose === 'function') {
      // Cordis 的 effect 回调会被立即调用，返回值才是 disposer。
      ctx.effect(() => dispose, NAME + ': room proxy and routes')
    }
  } catch (error) {
    say('error', '[' + NAME + '] 初始化失败（不会影响 DSH 本身）：' + (error && error.stack ? error.stack : error))
  }
}

function setup(ctx, config) {
  try {
    sink = (() => {
      try {
        const candidate = ctx && ctx.logger
        if (typeof candidate === 'function') {
          const made = candidate(NAME)
          if (made && typeof made.info === 'function') return made
        }
        if (candidate && typeof candidate.info === 'function') return candidate
      } catch { /* 落到 console */ }
      return console
    })()
  } catch { /* 忽略 */ }

  const webServer = ctx && ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    say('warn', '[' + NAME + '] 当前宿主没有 webServer 服务，房间联机不可用')
    return null
  }

  let webPort = 0
  try { webPort = Number(webServer.port) || 0 } catch { webPort = 0 }
  if (!webPort) {
    say('warn', '[' + NAME + '] 读不到 DSH Web 端口，房间联机不可用')
    return null
  }

  const cfg = {
    port: clampPort(config.port, DEFAULT_PORT),
    name: cleanText(config.name, 40),
    code: cleanText(config.code, 32),
    workspace: cleanText(config.workspace, 1024),
  }

  const room = {
    active: false,
    id: '',
    name: '',
    port: 0,
    code: '',
    workspace: '',
    hostToken: '',
    startedAt: 0,
    server: null,
    sockets: new Set(),
  }
  const members = new Map()
  const tokens = new Map()
  const joinAttempts = new Map()
  const handshakes = new Map()

  // 每个房客 TCP 连接一份守卫状态（streamId→端点、workspaceId→路径 的对应关系）
  const sharedWorkspaces = new Map()
  const guards = new WeakMap()
  function guardFor(socket) {
    let guard = guards.get(socket)
    if (!guard) {
      guard = createGuestGuard({ isBlockedPath, modeForPath, workspaces: sharedWorkspaces, sessionModes: sharedSessionModes })
      guards.set(socket, guard)
    }
    return guard
  }

  // 房客新建的会话：代理登记 sessionId → 房主策略对应的权限预设，
  // 在 session/created 时钉死（只读 / 仅工作区可写 / 完全权限）。
  const guestSessions = new Map()
  const sharedSessionModes = new Map()

  /* ───────────────────────── 工作区共享策略 ─────────────────────────
   * 默认全部封锁：房客连工作区名字都看不到，房主在面板里逐个「开放」并选权限。
   * 权限四档：
   *   blocked   不可见、不可列目录
   *   readonly  可看名字/文件树，不可改
   *   write     仅在该工作区内修改（工作区沙箱）
   *   full      完全权限（等同房主）
   * 条目可以是工作区根目录，也可以是工作区里的某个子文件夹；最长前缀生效。
   * 策略落盘在 ~/.dsh/dsh-room-policy.json，重启后仍然有效。
   */
  const POLICY_FILE = join(dshHome(), 'dsh-room-policy.json')
  const POLICY_MODES = ['blocked', 'readonly', 'write', 'full']
  const POLICY_MAX_ENTRIES = 200
  let policy = loadPolicy()

  function normalizePath(value) {
    try {
      const abs = resolve(String(value || ''))
      return process.platform === 'win32' ? abs.toLowerCase() : abs
    } catch { return '' }
  }

  function sanitizePolicy(data) {
    if (!data || typeof data !== 'object') return null
    const defaultMode = POLICY_MODES.includes(data.defaultMode) ? data.defaultMode : 'blocked'
    const entries = []
    const seen = new Set()
    for (const raw of Array.isArray(data.entries) ? data.entries.slice(0, POLICY_MAX_ENTRIES) : []) {
      if (!raw || typeof raw !== 'object') continue
      const rawPath = cleanText(raw.path, 1024)
      if (!rawPath) continue
      let abs
      try { abs = resolve(rawPath) } catch { continue }
      const key = normalizePath(abs)
      if (!key || seen.has(key)) continue
      seen.add(key)
      entries.push({ path: abs, mode: POLICY_MODES.includes(raw.mode) ? raw.mode : 'blocked' })
    }
    return { version: 1, defaultMode, entries }
  }

  function loadPolicy() {
    try {
      const parsed = JSON.parse(readFileSync(POLICY_FILE, 'utf8'))
      return sanitizePolicy(parsed) || { version: 1, defaultMode: 'blocked', entries: [] }
    } catch {
      return { version: 1, defaultMode: 'blocked', entries: [] }
    }
  }

  function savePolicy(next) {
    policy = next
    try {
      writeFileSync(POLICY_FILE, JSON.stringify(policy, null, 2), 'utf8')
    } catch (error) {
      say('warn', '[' + NAME + '] 保存工作区策略失败：' + (error && error.message ? error.message : error))
    }
  }

  // 最长前缀匹配：子文件夹的条目覆盖工作区根目录的条目。
  function modeForPath(target) {
    const key = normalizePath(target)
    if (!key) return 'blocked'
    const separator = process.platform === 'win32' ? '\\' : '/'
    let best = -1
    let mode = policy.defaultMode
    for (const entry of policy.entries) {
      const base = normalizePath(entry.path)
      if (!base) continue
      if (key === base || key.startsWith(base.endsWith(separator) ? base : base + separator)) {
        if (base.length > best) { best = base.length; mode = entry.mode }
      }
    }
    return mode
  }

  function isBlockedPath(target) {
    return modeForPath(target) === 'blocked'
  }

  // 房客能看见的工作区清单：被封锁的直接不出现在返回里（名字也不给）。
  function guestWorkspaces() {
    const list = []
    for (const item of workspacesFromHome()) {
      const mode = modeForPath(item.path)
      if (mode === 'blocked') continue
      list.push({ id: item.id, title: item.title, mode })
    }
    return list
  }

  // 文件树里被封锁的子文件夹 / 文件同样隐藏。
  function visibleEntries(root, rel) {
    const base = resolve(root)
    const entries = listDir(root, rel)
    return entries.filter((entry) => {
      const abs = resolve(base, String(entry.path || entry.name))
      return !isBlockedPath(abs)
    })
  }

  function launchToken() {
    try {
      const connection = ctx.connection || (ctx.get && ctx.get('connection'))
      if (!connection || typeof connection.authenticatedUrl !== 'function') {
        say('warn', '[' + NAME + '] 宿主没有 connection.authenticatedUrl，房客需要手动带令牌访问')
        return ''
      }
      const url = connection.authenticatedUrl('http://127.0.0.1:' + webPort)
      if (typeof url !== 'string') return ''
      const parsed = new URL(url)
      return parsed.searchParams.get('token') || ''
    } catch (error) {
      say('warn', '[' + NAME + '] 获取启动令牌失败：' + (error && error.message ? error.message : error))
      return ''
    }
  }

  function prune() {
    const now = Date.now()
    for (const [id, member] of members) {
      if (member.kind === 'host') continue
      if (now - member.lastSeen > MEMBER_TTL) {
        members.delete(id)
        if (member.token) tokens.delete(member.token)
      }
    }
  }

  function memberList() {
    prune()
    const list = Array.from(members.values())
    list.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'host' ? -1 : 1
      return a.joinedAt - b.joinedAt
    })
    return list.map((m) => ({
      id: m.id,
      name: m.name,
      kind: m.kind,
      joinedAt: m.joinedAt,
      lastSeen: m.lastSeen,
    }))
  }

  function touchHost(req) {
    let ip = ''
    try { ip = String(req.socket.remoteAddress || '') } catch { ip = '' }
    const existing = members.get('host')
    if (existing) {
      existing.lastSeen = Date.now()
      return existing
    }
    const member = {
      id: 'host',
      name: cfg.name || cleanText(hostname(), 40),
      kind: 'host',
      ip,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      token: '',
    }
    members.set('host', member)
    return member
  }

  function authMember(req, url) {
    const header = String(req.headers.authorization || '')
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
    const token = url.searchParams.get('token') || bearer || String(req.headers['x-room-token'] || '')
    if (!token) return null
    if (room.active && room.hostToken && safeEqual(token, room.hostToken)) {
      return { id: 'host', name: cfg.name || '房主', kind: 'host', isHostToken: true }
    }
    const id = tokens.get(token)
    if (!id) return null
    const member = members.get(id)
    if (!member) { tokens.delete(token); return null }
    member.lastSeen = Date.now()
    return member
  }

  function tooManyAttempts(ip) {
    const now = Date.now()
    const record = joinAttempts.get(ip)
    if (!record || now - record.at > 60_000) {
      joinAttempts.set(ip, { count: 1, at: now })
      return false
    }
    record.count += 1
    return record.count > 8
  }

  function publicRoom() {
    const workspaceMode = room.active ? modeForPath(room.workspace) : 'blocked'
    return {
      id: room.id,
      name: room.name,
      port: room.port,
      startedAt: room.startedAt,
      needsCode: Boolean(room.code),
      // 工作区被封锁时，连目录名都不能出现在房客的响应里。
      workspace: workspaceMode === 'blocked' ? '' : basename(room.workspace || ''),
      workspaceMode,
    }
  }

  function workspacePayload() {
    const mode = room.workspace ? modeForPath(room.workspace) : 'blocked'
    if (mode === 'blocked') {
      return { available: false, mode: 'blocked', name: '', entries: [] }
    }
    try {
      return {
        available: true,
        mode,
        root: room.workspace,
        name: basename(room.workspace || '') || 'workspace',
        entries: visibleEntries(room.workspace, ''),
      }
    } catch (error) {
      return { available: true, mode, root: room.workspace, name: basename(room.workspace || ''), entries: [], error: String(error && error.code || error) }
    }
  }

  /* ───────────────────────── 房间生命周期 ───────────────────────── */

  async function stopRoom() {
    const server = room.server
    room.active = false
    room.server = null
    room.hostToken = ''
    for (const socket of room.sockets) {
      try { socket.destroy() } catch { /* 忽略 */ }
    }
    room.sockets.clear()
    members.clear()
    tokens.clear()
    if (server) {
      await new Promise((done) => {
        try { server.close(() => done()) } catch { done() }
        setTimeout(done, 1500)
      })
    }
  }

  function createRoomServer() {
    const server = createServer((req, res) => {
    try { void handleProxy(req, res) } catch (error) {
      say('error', '[' + NAME + '] 代理请求异常：' + (error && error.stack ? error.stack : error))
      try { res.destroy() } catch { /* 忽略 */ }
    }
  })
    server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head))
    server.on('connection', (socket) => {
      room.sockets.add(socket)
      socket.on('close', () => room.sockets.delete(socket))
      socket.on('error', () => {})
    })
    return server
  }

  function listenOn(server, port) {
    return new Promise((resolvePromise, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        const address = server.address()
        resolvePromise(address && typeof address === 'object' ? address.port : port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '0.0.0.0')
    })
  }

  async function startRoom(options) {
    await stopRoom()
    let lastError = null
    for (let port = options.port; port < options.port + 10; port += 1) {
      const server = createRoomServer()
      try {
        const actual = await listenOn(server, port)
        room.server = server
        room.active = true
        room.id = randomBytes(4).toString('hex')
        room.name = options.name
        room.port = actual
        room.code = options.code
        room.workspace = options.workspace
        room.hostToken = randomBytes(18).toString('hex')
        room.startedAt = Date.now()
        touchHost({ socket: {} })
        say('info', '[' + NAME + '] 房间已开启：' + (urlsFor(actual)[0] || { url: 'http://127.0.0.1:' + actual }).url)
        return { port: actual }
      } catch (error) {
        lastError = error
        try { server.close() } catch { /* 忽略 */ }
        if (error && error.code !== 'EADDRINUSE') break
      }
    }
    throw lastError || new Error('listen-failed')
  }

  /* ───────────────────────── 代理 ───────────────────────── */

  // 需要读 body 才能判定的房客端点（与 lib/guard.mjs 的 INSPECT_ENDPOINTS 保持一致）。
  const INSPECT_BODY_ENDPOINTS = new Set([
    '/api/session/create',
    '/api/session/prompt',
    '/api/session/cancel',
    '/api/session/updateQueue',
    '/api/session/rename',
    '/api/session/fork',
    '/api/session/selectModel',
    '/api/session/openWorkspacePath',
    '/api/commands/execute',
    '/api/settings/update',
  ])

  function handleProxy(req, res) {
    let pathname = '/'
    try { pathname = new URL(String(req.url || '/'), 'http://room.invalid').pathname } catch { pathname = '/' }

    let decodedPath = pathname
    try { decodedPath = decodeURIComponent(pathname) } catch { /* 保留原样 */ }
    if (decodedPath.startsWith(PREFIX + '/api/host') && !isLoopback(req.socket.remoteAddress)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('host-only')
      return
    }

    // 房客（非 loopback 来源）按工作区策略拦截：审批回答 + 被封锁路径的文件读取。
    const guest = !isLoopback(req.socket.remoteAddress) ? guardFor(req.socket) : null
    if (guest) {
      let requestUrl = null
      try { requestUrl = new URL(String(req.url || '/'), 'http://room.invalid') } catch { requestUrl = null }
      const verdict = requestUrl ? guest.judgeRequest(pathname, req.method, requestUrl) : null
      if (verdict === 'approval-owner-only' || verdict === 'workspace-blocked') {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: verdict }))
        return
      }
    }

    const headers = stripHopByHop(req.headers)
    headers.host = '127.0.0.1:' + webPort
    headers['x-forwarded-for'] = String(req.socket.remoteAddress || '')
    headers['x-forwarded-proto'] = 'http'

    const isRoomPath = pathname === PREFIX || pathname.startsWith(PREFIX + '/')
    // 信任栅栏对 Host/Origin 一起校验：所有入站请求都伪装成 loopback 同源，
    // 原始 Origin 单独存一份给 /room 的 CORS 回显用（否则房客的跨源请求会被拒）。
    const inboundOrigin = String(req.headers.origin || '')
    if (inboundOrigin) headers['x-room-origin'] = inboundOrigin
    else delete headers['x-room-origin']
    headers.origin = 'http://127.0.0.1:' + webPort
    if (headers.referer) headers.referer = rewriteReferer(headers.referer, webPort)
    headers['sec-fetch-site'] = 'same-origin'

    let path = String(req.url || '/')
    const isIndex = !isRoomPath && (pathname === '/' || pathname === '/index.html') &&
      String(req.headers.accept || '').includes('text/html')

    if (isIndex) {
      if (cookieHasDsh(req.headers.cookie)) {
        handshakes.delete(String(req.socket.remoteAddress || ''))
      } else {
        const ip = String(req.socket.remoteAddress || '')
        const now = Date.now()
        const record = handshakes.get(ip)
        if (!record || now - record.at > HANDSHAKE_WINDOW) {
          handshakes.set(ip, { count: 1, at: now })
        } else {
          record.count += 1
        }
        if (record && record.count > HANDSHAKE_LIMIT) {
          sendHtml(res, 200, COOKIE_PAGE)
          return
        }
        const token = launchToken()
        if (!token) {
          sendHtml(res, 200, NO_TOKEN_PAGE)
          return
        }
        path = addToken(path, token)
      }
    }

    // 需要读/改写的响应（房客的会话列表、会话创建回执）先要求上游不压缩，
    // 否则我们改写明文 body 但保留 content-encoding，浏览器会 ERR_CONTENT_DECODING_FAILED。
    if (guest && (pathname === '/api/session/list' || pathname === '/api/session/create')) {
      delete headers['accept-encoding']
    }

    const inboundHost = String(req.headers.host || '')
    const inboundProto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http'))

    // 房客的信封需要先读 body 才能判定（session/create 的落点、/permission 与 settings 改写入口）。
    const inspectBody = Boolean(guest) && req.method === 'POST' &&
      INSPECT_BODY_ENDPOINTS.has(pathname)
    let pendingCreate = null

    const upstream = httpRequest({
      host: '127.0.0.1',
      port: webPort,
      method: req.method,
      path,
      headers,
      agent: false,
    }, (response) => {
      const status = response.statusCode || 502
      const type = String(response.headers['content-type'] || '')
      // 浏览器里残留着上一个 DSH 进程的 dsh-auth cookie 时，宿主会回 401
      // （"dsh web authentication required; reopen the URL printed by dsh web"）。
      // 用本进程的启动令牌重跳一次，让宿主重新下发有效 cookie。
      if (status === 401 && isIndex) {
        response.resume()
        const token = launchToken()
        if (token) {
          const location = inboundProto + '://' + inboundHost + addToken(path, token)
          if (!res.headersSent && !res.writableEnded) {
            res.writeHead(302, { location, 'cache-control': 'no-store' })
            res.end()
          }
        } else if (!res.headersSent && !res.writableEnded) {
          sendHtml(res, 200, GATE_PAGE)
        }
        return
      }
      if (status === 403 && isIndex && /text\/plain/i.test(type)) {
        const chunks = []
        let total = 0
        response.on('data', (chunk) => {
          total += chunk.length
          if (total <= 4096) chunks.push(chunk)
        })
        response.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8').trim().toLowerCase()
            if (text === 'forbidden' || text.includes('forbidden')) {
              if (!res.headersSent && !res.writableEnded) sendHtml(res, 200, GATE_PAGE)
              return
            }
            if (!res.headersSent && !res.writableEnded) {
              res.writeHead(status, response.headers)
              res.end(Buffer.concat(chunks))
            } else { try { res.destroy() } catch { /* 忽略 */ } }
          } catch (error) {
            say('warn', '[' + NAME + '] 闸门页处理异常：' + (error && error.message ? error.message : error))
            try { res.destroy() } catch { /* 忽略 */ }
          }
        })
        response.on('error', () => { try { res.destroy() } catch { /* 忽略 */ } })
        return
      }
      const outHeaders = stripHopByHop(response.headers)
      if (outHeaders.location) {
        outHeaders.location = rewriteLocation(outHeaders.location, inboundHost, inboundProto, webPort)
      }
      if (outHeaders['set-cookie']) {
        outHeaders['set-cookie'] = rewriteSetCookie(outHeaders['set-cookie'], inboundProto)
      }
      if (guest && pathname === '/api/session/list' && /application\/json/i.test(type)) {
        // 会话列表带 cwd：按策略过滤掉被封锁工作区里的会话，避免路径和标题泄漏。
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const filtered = guest.filterResponse(pathname, text) || text
          delete outHeaders['content-encoding']
          delete outHeaders['content-length']
          outHeaders['content-type'] = 'application/json; charset=utf-8'
          if (!res.headersSent && !res.writableEnded) {
            res.writeHead(status, outHeaders)
            res.end(filtered)
          } else { try { res.destroy() } catch { /* 忽略 */ } }
        })
        response.on('error', () => { try { res.destroy() } catch { /* 忽略 */ } })
        return
      }
      if (guest && pathname === '/api/session/create' && /application\/json/i.test(type)) {
        // 记下房客新建的会话，交给 session/created 钉权限。
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            const payload = JSON.parse(text)
            const value = payload && payload.result && payload.result.value
            const sessionId = value && value.sessionId
            if (sessionId && pendingCreate) {
              guestSessions.set(String(sessionId), { mode: pendingCreate.mode })
              guest.rememberSessionMode(String(sessionId), pendingCreate.mode)
            }
          } catch { /* 忽略 */ }
          delete outHeaders['content-encoding']
          delete outHeaders['content-length']
          if (!res.headersSent && !res.writableEnded) {
            res.writeHead(status, outHeaders)
            res.end(text)
          } else { try { res.destroy() } catch { /* 忽略 */ } }
        })
        response.on('error', () => { try { res.destroy() } catch { /* 忽略 */ } })
        return
      }
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(status, outHeaders)
        response.pipe(res)
      } else {
        response.resume()
        try { res.destroy() } catch { /* 忽略 */ }
      }
    })

    upstream.on('error', (error) => {
      if (res.headersSent) { try { res.destroy() } catch { /* 忽略 */ } return }
      sendHtml(res, 502, '<!doctype html><meta charset="utf-8"><body style="background:#0f1115;color:#e6e8ee;font:15px system-ui;padding:40px">房间代理连不上 DSH 宿主：' +
        String(error && error.message ? error.message : error).replace(/[<>&]/g, '') + '</body>')
    })
    req.on('error', () => { try { upstream.destroy() } catch { /* 忽略 */ } })
    if (inspectBody) {
      const chunks = []
      let total = 0
      let aborted = false
      req.on('data', (chunk) => {
        total += chunk.length
        if (total > 2 * 1024 * 1024) {
          aborted = true
          if (!res.headersSent && !res.writableEnded) {
            res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: false, error: 'payload-too-large' }))
          } else { try { res.destroy() } catch { /* 忽略 */ } }
          try { upstream.destroy() } catch { /* 忽略 */ }
          req.resume()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (aborted) return
        const text = Buffer.concat(chunks).toString('utf8')
        const verdict = guest.judgeBody(pathname, text)
        if (verdict && verdict.deny) {
          sendJson(res, 403, { ok: false, error: verdict.deny })
          return
        }
        if (verdict && verdict.create) pendingCreate = verdict.create
        upstream.end(text)
      })
    } else {
      req.pipe(upstream)
    }
  }

  function handleUpgrade(req, socket, head) {
    socket.on('error', () => {})
    const headers = Object.assign({}, req.headers)
    headers.host = '127.0.0.1:' + webPort
    headers.origin = 'http://127.0.0.1:' + webPort
    headers['sec-fetch-site'] = 'same-origin'

    const upstream = httpRequest({
      host: '127.0.0.1',
      port: webPort,
      method: req.method,
      path: String(req.url || '/'),
      headers,
      agent: false,
    })

    const isMux = String(req.url || '').includes('/api/remote.mux')
    const guestGuard = isMux && !isLoopback(req.socket.remoteAddress) ? guardFor(req.socket) : null

    upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      const lines = ['HTTP/1.1 101 Switching Protocols']
      for (const key of Object.keys(response.headers)) {
        const value = response.headers[key]
        lines.push(key + ': ' + (Array.isArray(value) ? value.join(', ') : value))
      }
      try { socket.write(lines.join('\r\n') + '\r\n\r\n') } catch { /* 忽略 */ }
      if (guestGuard) {
        // 帧级过滤：只对房客的 remote.mux 生效（协议见 docs/protocol-notes.md）。
        const toClient = createFrameTransformer({
          masked: false,
          onText(text) {
            let frame
            try { frame = JSON.parse(text) } catch { return undefined }
            const next = guestGuard.serverFrame(frame)
            if (!next) return null
            // 过滤器是原地修改，必须重新序列化，否则转发的是旧字节（踩过）。
            return JSON.stringify(next)
          },
        })
        const toServer = createFrameTransformer({
          masked: true,
          onText(text) {
            let frame
            try { frame = JSON.parse(text) } catch { return undefined }
            const next = guestGuard.clientFrame(frame)
            if (!next) return null
            return JSON.stringify(next)
          },
        })
        if (upstreamHead && upstreamHead.length) {
          try { socket.write(toClient.push(upstreamHead)) } catch { /* 忽略 */ }
        }
        if (head && head.length) {
          try { upstreamSocket.write(toServer.push(head)) } catch { /* 忽略 */ }
        }
        upstreamSocket.on('data', (chunk) => { try { socket.write(toClient.push(chunk)) } catch { /* 忽略 */ } })
        socket.on('data', (chunk) => { try { upstreamSocket.write(toServer.push(chunk)) } catch { /* 忽略 */ } })
      } else {
        if (upstreamHead && upstreamHead.length) {
          try { socket.write(upstreamHead) } catch { /* 忽略 */ }
        }
        if (head && head.length) {
          try { upstreamSocket.write(head) } catch { /* 忽略 */ }
        }
        upstreamSocket.pipe(socket, { end: false })
        socket.pipe(upstreamSocket, { end: false })
      }
      const close = () => {
        try { upstreamSocket.destroy() } catch { /* 忽略 */ }
        try { socket.destroy() } catch { /* 忽略 */ }
      }
      upstreamSocket.on('error', close)
      upstreamSocket.on('close', close)
      socket.on('error', close)
      socket.on('close', close)
    })

    upstream.on('response', (response) => {
      try {
        socket.write('HTTP/1.1 ' + (response.statusCode || 502) + ' Bad Gateway\r\nConnection: close\r\n\r\n')
      } catch { /* 忽略 */ }
      try { socket.destroy() } catch { /* 忽略 */ }
      response.resume()
    })

    upstream.on('error', () => { try { socket.destroy() } catch { /* 忽略 */ } })
    upstream.end()
  }

  /* ───────────────────────── /room API ───────────────────────── */

  async function handleRoom(req, res) {
    const cors = corsHeaders(req)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }

    let url
    try { url = new URL(String(req.url || '/'), 'http://room.invalid') } catch {
      sendJson(res, 400, { ok: false, error: 'bad-url' }, cors)
      return
    }
    const path = url.pathname.replace(/\/+$/, '') || PREFIX
    // 房客请求是房间代理从 loopback 转进来的，真实来源在 x-forwarded-for（代理会覆写）。
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      String(req.socket.remoteAddress || '')

    try {
      if (path === PREFIX + '/api/ping' || path === PREFIX + '/api/health') {
        sendJson(res, 200, {
          ok: true,
          app: NAME,
          version: VERSION,
          room: room.active,
          name: room.active ? room.name : '',
          needsCode: room.active ? Boolean(room.code) : false,
          port: room.active ? room.port : 0,
          host: hostname(),
        }, cors)
        return
      }

      if (path === PREFIX + '/api/join' && req.method === 'POST') {
        if (!room.active) {
          sendJson(res, 404, { ok: false, error: 'no-room' }, cors)
          return
        }
        if (tooManyAttempts(ip)) {
          sendJson(res, 429, { ok: false, error: 'too-many-attempts' }, cors)
          return
        }
        const body = (await readJson(req)) || {}
        if (room.code && !safeEqual(body.code, room.code)) {
          sendJson(res, 403, { ok: false, error: 'bad-code' }, cors)
          return
        }
        const name = cleanText(body.name, 24) || '访客'
        const id = 'g' + randomBytes(3).toString('hex')
        const token = randomBytes(24).toString('hex')
        const member = {
          id,
          token,
          name,
          kind: 'guest',
          ip,
          joinedAt: Date.now(),
          lastSeen: Date.now(),
        }
        members.set(id, member)
        tokens.set(token, id)
        sendJson(res, 200, {
          ok: true,
          token,
          self: { id, name },
          room: publicRoom(),
          members: memberList(),
          workspaces: guestWorkspaces(),
          workspace: workspacePayload(),
        }, cors)
        return
      }

      if (path === PREFIX + '/api/state' && req.method === 'GET') {
        const member = authMember(req, url)
        if (!member) {
          // stale 明确告诉客户端「你的令牌已经失效」，让它自动重新入房
          sendJson(res, 401, { ok: false, error: 'unauthorized', stale: true }, cors)
          return
        }
        if (!room.active) {
          sendJson(res, 404, { ok: false, error: 'no-room' }, cors)
          return
        }
        touchHost({ socket: { remoteAddress: '' } })
        sendJson(res, 200, {
          ok: true,
          room: publicRoom(),
          members: memberList(),
          workspaces: guestWorkspaces(),
          workspace: workspacePayload(),
        }, cors)
        return
      }

      if (path === PREFIX + '/api/list' && req.method === 'GET') {
        const member = authMember(req, url)
        if (!member) {
          sendJson(res, 401, { ok: false, error: 'unauthorized' }, cors)
          return
        }
        if (!room.active) {
          sendJson(res, 404, { ok: false, error: 'no-room' }, cors)
          return
        }
        const rel = String(url.searchParams.get('path') || '').replace(/\\/g, '/').replace(/^\/+/, '')
        // 目录级策略：未开放（或被封锁的子文件夹）连列目录都不允许，避免路径泄漏。
        if (isBlockedPath(join(room.workspace, rel))) {
          sendJson(res, 403, { ok: false, error: 'workspace-blocked' }, cors)
          return
        }
        try {
          const entries = visibleEntries(room.workspace, rel)
          sendJson(res, 200, { ok: true, path: rel, mode: modeForPath(join(room.workspace, rel)), entries }, cors)
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error && error.code || 'list-failed') }, cors)
        }
        return
      }

      if (path === PREFIX + '/api/heartbeat' && req.method === 'POST') {
        const member = authMember(req, url)
        if (!member) {
          // 令牌失效（典型场景：手机切后台超过 TTL 被清理）→ 客户端据此自动重入
          sendJson(res, 401, { ok: false, error: 'unauthorized', stale: true }, cors)
          return
        }
        if (!room.active) {
          sendJson(res, 404, { ok: false, error: 'no-room' }, cors)
          return
        }
        // 一次心跳把面板要的数据都带回去，手机上少一次往返
        sendJson(res, 200, {
          ok: true,
          room: publicRoom(),
          members: memberList(),
          workspaces: guestWorkspaces(),
          workspace: workspacePayload(),
        }, cors)
        return
      }

      if (path === PREFIX + '/api/leave' && req.method === 'POST') {
        const member = authMember(req, url)
        if (member && member.kind === 'guest') {
          members.delete(member.id)
          if (member.token) tokens.delete(member.token)
        }
        sendJson(res, 200, { ok: true }, cors)
        return
      }

      if (path === PREFIX + '/api/host/state' && req.method === 'GET') {
        touchHost(req)
        const hostToken = room.active ? room.hostToken : ''
        sendJson(res, 200, {
          ok: true,
          running: room.active,
          room: room.active ? {
            id: room.id,
            name: room.name,
            port: room.port,
            code: room.code,
            startedAt: room.startedAt,
            workspace: room.workspace,
            needsCode: Boolean(room.code),
          } : null,
          urls: room.active ? urlsFor(room.port) : [],
          members: room.active ? memberList() : [],
          workspaces: workspacesFromHome().map((item) => ({ ...item, mode: modeForPath(item.path) })),
          defaultWorkspace: cfg.workspace || defaultWorkspace(),
          roomWorkspaceMode: room.active ? modeForPath(room.workspace) : 'blocked',
          policy,
          workspace: room.active ? workspacePayload() : null,
          hostToken,
          version: VERSION,
          dshPort: webPort,
        }, cors)
        return
      }

      if (path === PREFIX + '/api/host/policy' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, policy }, cors)
        return
      }

      if (path === PREFIX + '/api/host/policy' && req.method === 'POST') {
        const body = (await readJson(req)) || {}
        const next = sanitizePolicy(body)
        if (!next) {
          sendJson(res, 400, { ok: false, error: 'bad-policy' }, cors)
          return
        }
        savePolicy(next)
        say('info', '[' + NAME + '] 工作区策略已更新：' + next.entries.length + ' 条，默认 ' + next.defaultMode)
        sendJson(res, 200, { ok: true, policy }, cors)
        return
      }

      // 房主端的文件夹选择器：列任意绝对路径，方便把「工作区里的某个文件夹」单独开放。
      if (path === PREFIX + '/api/host/fs' && req.method === 'GET') {
        const target = cleanText(url.searchParams.get('path') || '', 1024)
        if (!target) {
          sendJson(res, 400, { ok: false, error: 'no-path' }, cors)
          return
        }
        try {
          const abs = resolve(target)
          const entries = listDir(abs, '').map((entry) => ({
            name: entry.name,
            type: entry.type,
            path: resolve(abs, entry.name),
            mode: modeForPath(resolve(abs, entry.name)),
          }))
          sendJson(res, 200, { ok: true, path: abs, entries }, cors)
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error && error.code || 'list-failed') }, cors)
        }
        return
      }

      if (path === PREFIX + '/api/host/start' && req.method === 'POST') {
        const body = (await readJson(req)) || {}
        const port = clampPort(body.port, cfg.port)
        const workspaceCandidate = cleanText(body.workspace, 1024) || cfg.workspace || defaultWorkspace()
        let workspace = workspaceCandidate
        try {
          if (!statSync(workspace).isDirectory()) throw new Error('not-a-directory')
        } catch {
          workspace = defaultWorkspace()
        }
        const roomName = cleanText(body.name, 40) || cfg.name || (cleanText(hostname(), 40) + ' 的房间')
        const roomCode = cleanText(body.code, 32)
        try {
          const started = await startRoom({ port, name: roomName, code: roomCode, workspace })
          sendJson(res, 200, {
            ok: true,
            room: {
              id: room.id,
              name: room.name,
              port: room.port,
              code: room.code,
              startedAt: room.startedAt,
              workspace: room.workspace,
              needsCode: Boolean(room.code),
            },
            urls: urlsFor(started.port),
            members: memberList(),
            hostToken: room.hostToken,
          }, cors)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error && error.code || error && error.message || 'start-failed') }, cors)
        }
        return
      }

      if (path === PREFIX + '/api/host/stop' && req.method === 'POST') {
        await stopRoom()
        sendJson(res, 200, { ok: true, running: false }, cors)
        return
      }

      if (path === PREFIX + '/api/host/kick' && req.method === 'POST') {
        const body = (await readJson(req)) || {}
        const id = cleanText(body.id, 64)
        const member = members.get(id)
        if (member && member.kind === 'guest') {
          members.delete(id)
          if (member.token) tokens.delete(member.token)
        }
        sendJson(res, 200, { ok: true, members: memberList() }, cors)
        return
      }

      sendJson(res, 404, { ok: false, error: 'not-found' }, cors)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error && error.message || error) }, cors)
    }
  }

  let offRoute
  try {
    offRoute = webServer.register({ kind: 'prefix', path: PREFIX, handler: (req, res) => { void handleRoom(req, res) } })
  } catch (error) {
    say('error', '[' + NAME + '] 注册 /room 路由失败：' + (error && error.message ? error.message : error))
    return null
  }

  say('info', '[' + NAME + '] 就绪：web=' + webPort + '，等待创建房间')

  // 房客会话的权限由房主策略钉死：readonly → read-only，write → workspace-write，full → danger-full-access。
  // 房客的 /permission 与 settings(permission) 写入口已在代理层拒绝，这里是纵深防御的第二层。
  const PRESET_FOR_MODE = { readonly: 'read-only', write: 'workspace-write', full: 'danger-full-access' }
  if (typeof ctx.on === 'function') {
    try {
      ctx.on('session/created', (session) => {
        const id = String((session && session.id) || '')
        const record = guestSessions.get(id)
        if (!record) return
        guestSessions.delete(id)
        const presets = ctx.permissionPresets
        const name = PRESET_FOR_MODE[record.mode]
        if (!name || !presets || typeof presets.set !== 'function') return
        try {
          if (Array.isArray(presets.names) && !presets.names.includes(name)) {
            say('warn', '[' + NAME + '] 当前 DSH 没有权限预设 ' + name + '，房客会话保持默认权限')
            return
          }
          presets.set(session, name)
          say('info', '[' + NAME + '] 房客会话 ' + id.slice(0, 18) + ' 权限钉为 ' + name)
        } catch (error) {
          say('warn', '[' + NAME + '] 设置房客会话权限失败：' + (error && error.message ? error.message : error))
        }
      })
    } catch (error) {
      say('warn', '[' + NAME + '] 注册 session/created 钩子失败：' + (error && error.message ? error.message : error))
    }
  }

  return async () => {
    try { if (typeof offRoute === 'function') offRoute() } catch { /* 忽略 */ }
    await stopRoom()
  }
}
