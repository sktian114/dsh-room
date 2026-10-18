/**
 * 抓房客页面的真实网络行为：HTTP 请求 + WebSocket 帧（用于设计工作区封锁/审批路由）。
 * 用法：node test/probe-frames.mjs <roomUrl> <outFile>
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roomUrl = (process.argv[2] || 'http://192.168.1.5:8787/').replace(/\/?$/, '/')
const outFile = process.argv[3] || join(tmpdir(), 'dsh-room-frames.json')
const CHROME = process.env.DSH_ROOM_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const port = 9444
const profile = mkdtempSync(join(tmpdir(), 'dsh-room-probe-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=430,932', 'about:blank',
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
const frames = []
const requests = []
const inflight = new Map()
const wanted = new Map()
const bodies = []
ws.onmessage = async (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id); pending.delete(msg.id); resolve(msg.result)
  }
  const { method, params } = msg
  if (method === 'Network.webSocketFrameReceived' || method === 'Network.webSocketFrameSent') {
    const dir = method.endsWith('Received') ? 'in' : 'out'
    frames.push({ t: Date.now(), dir, url: params.requestId, opcode: params.response.opcode, payload: params.response.payloadData.slice(0, Number(process.env.PROBE_LIMIT || 4000)) })
  }
  if (method === 'Network.requestWillBeSent') {
    requests.push({ t: Date.now(), method: params.request.method, url: params.request.url, type: params.type, postData: params.request.postData ? params.request.postData.slice(0, 800) : undefined })
    inflight.set(params.requestId, params.request.url)
  }
  if (method === 'Network.responseReceived') {
    const src = inflight.get(params.requestId)
    if (src) {
      requests.push({ t: Date.now(), status: params.response.status, url: src, mime: params.response.mimeType })
      if (src.includes('/api/session/list') || src.includes('/api/workspace')) {
        wanted.set(params.requestId, src)
        try {
          const body = await send('Network.getResponseBody', { requestId: params.requestId })
          bodies.push({ url: src, body: String(body.body || '').slice(0, 6000), base64: !!body.base64Encoded })
        } catch { /* 忽略 */ }
      }
    }
  }
}
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, { resolve })
  ws.send(JSON.stringify({ id, method, params }))
})

await send('Network.enable')
await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: roomUrl })
await sleep(12000)
// 滚一下、点一下，触发更多 RPC
await send('Runtime.evaluate', { expression: 'window.scrollTo(0, 400)', returnByValue: true })
await sleep(4000)

let domText = ''
try {
  const evaluated = await send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText.slice(0, 4000) : ' + String.fromCharCode(34,34), returnByValue: true })
  domText = String((evaluated && evaluated.result && evaluated.result.value) || '')
} catch { /* 忽略 */ }
writeFileSync(outFile, JSON.stringify({ roomUrl, frames, requests, bodies, domText }, null, 1))
console.log('frames', frames.length, 'requests', requests.length, '->', outFile)
try { ws.close() } catch {}
chrome.kill()
await sleep(500)
try { rmSync(profile, { recursive: true, force: true }) } catch {}
