/**
 * 以房客页面身份直接调 /api/session/list，并抓页面状态，用于诊断"工作区看不到对话"。
 * 用法：node test/probe-guest-api.mjs <roomUrl> <outFile>
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roomUrl = (process.argv[2] || 'http://192.168.1.5:8787/').replace(/\/?$/, '/')
const outFile = process.argv[3] || join(tmpdir(), 'dsh-room-guest-api.json')
const CHROME = process.env.DSH_ROOM_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const port = 9446
const profile = mkdtempSync(join(tmpdir(), 'dsh-room-guest-api-'))
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
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id); pending.delete(msg.id); resolve(msg.result)
  }
}
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, { resolve })
  ws.send(JSON.stringify({ id, method, params }))
})

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: roomUrl })
await sleep(14000)

async function evaluate(expression, awaitPromise) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: !!awaitPromise, returnByValue: true })
  return result && result.result ? result.result.value : undefined
}

const listCall = `(async () => {
  const res = await fetch('/api/session/list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ type: 'client-request', rpcId: 'r-' + Math.random().toString(36).slice(2) + '-' + Date.now(), method: 'session/list', payload: { args: { _request: {} } } }),
  })
  return JSON.stringify({ status: res.status, body: (await res.text()).slice(0, 4000) })
})()`
const sessionList = await evaluate(listCall, true)
console.error('DEBUG sessionList type:', typeof sessionList)
const domText = await evaluate('document.body ? document.body.innerText.slice(0, 6000) : ' + String.fromCharCode(34, 34))
const sidebarText = await evaluate(`(() => {
  const nodes = Array.from(document.querySelectorAll('[class*="workspace"], [class*="session"], aside, nav'))
  return nodes.map((node) => (node.innerText || '').slice(0, 500)).filter(Boolean).slice(0, 10).join('\\n---\\n')
})()`)

writeFileSync(outFile, JSON.stringify({ roomUrl, sessionList, domText, sidebarText }, null, 1))
console.log('session/list =', String(sessionList || '').slice(0, 300))
console.log('->', outFile)
try { ws.close() } catch {}
chrome.kill()
await sleep(500)
try { rmSync(profile, { recursive: true, force: true }) } catch {}
