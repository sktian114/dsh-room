/**
 * 只读守卫实测：以房客页面身份调 session/prompt 与 session/create，确认被拒。
 * 用法：node test/probe-readonly.mjs <roomUrl>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roomUrl = (process.argv[2] || 'http://192.168.1.5:8787/').replace(/\/?$/, '/')
const targetWorkspace = process.argv[3] || ''
const CHROME = process.env.DSH_ROOM_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const port = 9450
const profile = mkdtempSync(join(tmpdir(), 'dsh-room-readonly-'))
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
  if (msg.id && pending.has(msg.id)) { const entry = pending.get(msg.id); pending.delete(msg.id); entry.resolve(msg.result || msg.error) }
}
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, { resolve })
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression, awaitPromise) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: !!awaitPromise, returnByValue: true })
  if (result && result.exceptionDetails) return 'EXCEPTION: ' + JSON.stringify(result.exceptionDetails).slice(0, 200)
  return result && result.result ? result.result.value : undefined
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: roomUrl })
await sleep(14000)

const script = `(async () => {
  const call = async (endpoint, args) => {
    try {
      const res = await fetch('/api/' + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ type: 'client-request', rpcId: 'p-' + Math.random().toString(36).slice(2), method: endpoint, payload: { args } }),
      })
      return { endpoint, status: res.status, body: (await res.text()).slice(0, 6000) }
    } catch (error) { return { endpoint, error: String(error) } }
  }
  const out = []
  const listed = await call('session/list', { _request: {} })
  let sessionId = '${process.argv[4] || ''}'
  try {
    const payload = JSON.parse(listed.body)
    const items = payload.result.value.items
    if (!sessionId && items.length) sessionId = items[0].sessionId
  } catch { /* 忽略 */ }
  out.push({ step: 'list', status: listed.status, sessionId })
  out.push({ step: 'prompt', ...(await call('session/prompt', { request: { sessionId, prompt: '试试改一个文件' } })) })
  out.push({ step: 'create', ...(await call('session/create', { request: { cwd: ${JSON.stringify(targetWorkspace)} } })) })
  out.push({ step: 'commands', ...(await call('commands/execute', { agentId: sessionId, line: '/permission danger-full-access', submittedAttachments: [] })) })
  out.push({ step: 'settings', ...(await call('settings/update', { ns: 'permission', patch: { defaultPreset: 'danger-full-access' } })) })
  return JSON.stringify(out)
})()`

const report = await evaluate(script, true)
console.log(report)
try { ws.close() } catch {}
chrome.kill()
await sleep(500)
try { rmSync(profile, { recursive: true, force: true }) } catch {}
