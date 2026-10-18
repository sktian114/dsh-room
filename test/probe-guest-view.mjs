/**
 * 房客页面交互探针：点工作区 → 看会话列表是否出现，并顺便抓一次 session/list。
 * 用法：node test/probe-guest-view.mjs <roomUrl> <outFile>
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roomUrl = (process.argv[2] || 'http://192.168.1.5:8787/').replace(/\/?$/, '/')
const outFile = process.argv[3] || join(tmpdir(), 'dsh-room-guest-view.json')
const CHROME = process.env.DSH_ROOM_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const port = 9448
const profile = mkdtempSync(join(tmpdir(), 'dsh-room-guest-view-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' })

async function http(path, init) { return fetch(`http://127.0.0.1:${port}${path}`, init) }
let target
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await http('/json/list')).json()
    target = list.find((t) => t.type === 'page')
    if (target) break
  } catch { /* 还没起来 */ }
  await sleep(300)
}
if (!target) throw new Error('CDP not ready')

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let seq = 0
const pending = new Map()
const netEvents = []
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.method) netEvents.push({ method: msg.method, params: msg.params })
  if (msg.id && pending.has(msg.id)) {
    const entry = pending.get(msg.id); pending.delete(msg.id); entry.resolve(msg.result || msg.error)
  }
}
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, { resolve })
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression, awaitPromise) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: !!awaitPromise, returnByValue: true })
  if (result && result.exceptionDetails) return 'EXCEPTION: ' + JSON.stringify(result.exceptionDetails).slice(0, 300)
  return result && result.result ? result.result.value : undefined
}

await send('Network.enable')
await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: roomUrl })
await sleep(12000)
const before = await evaluate('document.body ? document.body.innerText.slice(0, 3000) : ' + String.fromCharCode(34, 34))

// 点第一个工作区条目
const clicked = await evaluate(`(() => {
  const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], [role="treeitem"], [class*="workspace"]'))
  const hit = nodes.find((node) => (node.innerText || '').trim().length > 0 && (node.innerText || '').trim().length < 40 && /workspace|项目|dsh|core|工作区/i.test(node.innerText || ''))
  if (!hit) return 'no-target'
  hit.click()
  return 'clicked: ' + (hit.innerText || '').trim().slice(0, 40)
})()`)
await sleep(3000)
// 再点一个会话标题，确认房客能打开对话
const clickedSession = await evaluate(`(() => {
  const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], [class*="session"]'))
  const hit = nodes.find((node) => {
    const text = (node.innerText || '').trim()
    return text.length > 4 && text.length < 60 && /dsh-room|内网穿透|文字/.test(text)
  })
  if (!hit) return 'no-session'
  hit.click()
  return 'session: ' + (hit.innerText || '').trim().slice(0, 40)
})()`)
await sleep(6000)
const after = await evaluate('document.body ? document.body.innerText.slice(0, 4000) : ' + String.fromCharCode(34, 34))

const sessionList = await evaluate(`(async () => {
  window.__probe = 'pending'
  try {
    const res = await fetch('/api/session/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ type: 'client-request', rpcId: 'p-' + Date.now(), method: 'session/list', payload: { args: { _request: {} } } }),
    })
    window.__probe = JSON.stringify({ status: res.status, body: (await res.text()).slice(0, 5000) })
  } catch (error) { window.__probe = 'fetch-failed: ' + String(error) }
  document.title = 'probe-done'
  return window.__probe
})()`, true)

const failures = netEvents.filter((e) => e.method === 'Network.loadingFailed').map((e) => ({ url: (netEvents.find((x) => x.method === 'Network.requestWillBeSent' && x.params.requestId === e.params.requestId) || {}).params, error: e.params.errorText, blocked: e.params.blockedReason })).slice(0, 10)
const apiResponses = netEvents.filter((e) => e.method === 'Network.responseReceived' && e.params.response.url.includes('/api/')).map((e) => ({ url: e.params.response.url, status: e.params.response.status })).slice(-30)
writeFileSync(outFile, JSON.stringify({ roomUrl, clicked, clickedSession, before, after, sessionList, failures, apiResponses }, null, 1))
console.log('clicked =', clicked)
console.log('->', outFile)
try { ws.close() } catch {}
chrome.kill()
await sleep(500)
try { rmSync(profile, { recursive: true, force: true }) } catch {}
