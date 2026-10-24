/**
 * 通用 CDP 探针：开一个 headless Chrome 打开某个 URL，等界面起来，跑一段 JS，打印结果。
 *
 * 用法：
 *   node test/probe-run.mjs --url=http://172.16.1.130:8787/ --js=test/probe-author.js [--wait=12000] [--port=9350]
 *
 * 两段式（先拿 cookie 再去目标页，同一个浏览器进程里 cookie 才在）：
 *   node test/probe-run.mjs --url=http://127.0.0.1:8787/ --url2=http://127.0.0.1:59740/ --wait=8000 --wait2=14000 --js=...
 *
 * 只读诊断：不改页面内容（探针脚本自己加的临时节点会自己删掉）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = new Map()
for (const arg of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(arg)
  if (m) args.set(m[1], m[2])
  else if (/^--[^=]+$/.test(arg)) args.set(arg.slice(2), '')
}
const url = args.get('url') || 'http://172.16.1.130:8787/'
const url2 = args.get('url2') || ''
const wait2Ms = Number(args.get('wait2') || 10000)
const scriptPath = args.get('js') || ''
const waitMs = Number(args.get('wait') || 12000)
const port = Number(args.get('port') || 9350)
const CHROME = args.get('chrome') || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profile = args.get('profile') || mkdtempSync(join(tmpdir(), 'probe-run-'))

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--window-size=1440,900',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  url,
], { stdio: ['ignore', 'ignore', 'pipe'] })

let stderr = ''
child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function json(path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`)
  return response.json()
}

async function waitForTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await json('/json/list')
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('CDP 目标没起来：' + stderr.slice(-400))
}

const page = await waitForTarget(15000)
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let seq = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  let payload
  try { payload = JSON.parse(event.data) } catch { return }
  if (payload.id && pending.has(payload.id)) {
    pending.get(payload.id)(payload)
    pending.delete(payload.id)
  }
})

function send(method, params) {
  const id = ++seq
  return new Promise((resolve) => {
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params: params || {} }))
  })
}

await send('Runtime.enable')
console.log('[probe] 打开 ' + url + '，等 ' + waitMs + 'ms 让界面起来…')
await sleep(waitMs)

// 两段式：先用第一段拿到 cookie（房间代理会把启动令牌换成 dsh-auth cookie），
// 再跳到真正要看的目标页 —— 同一个浏览器进程里 cookie 还在内存里（分两次跑会因为
// 进程被 kill、cookie 没落盘而丢掉）。
if (url2) {
  console.log('[probe] 再跳到 ' + url2 + '，等 ' + wait2Ms + 'ms…')
  await send('Page.navigate', { url: url2 })
  await sleep(wait2Ms)
}

const body = scriptPath ? readFileSync(scriptPath, 'utf8') : 'JSON.stringify({ok:true})'
const result = await send('Runtime.evaluate', {
  expression: body,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
})
const value = result && result.result && result.result.result
console.log('[probe] 结果：')
console.log(JSON.stringify(value && value.value !== undefined ? value.value : result, null, 2))

try { socket.close() } catch { /* 忽略 */ }
try { child.kill() } catch { /* 忽略 */ }
