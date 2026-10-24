/**
 * 连到 DSH 的 inspector CDP（默认 127.0.0.1:9230），在宿主域里跑表达式。
 * 用法：node inspector-probe.mjs "<表达式>" [更多表达式...]
 */
const endpoint = process.env.DSH_INSPECTOR || 'http://127.0.0.1:9230'

const version = await (await fetch(endpoint + '/json/version')).json()
const list = await (await fetch(endpoint + '/json/list')).json()
const target = list.find((item) => item.webSocketDebuggerUrl)
if (!target) throw new Error('没有可连的 target')

const socket = new WebSocket(target.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
socket.addEventListener('message', (event) => {
  let message = null
  try { message = JSON.parse(String(event.data)) } catch { return }
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  entry(message)
})
const send = (method, params) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, resolve)
  socket.send(JSON.stringify({ id, method, params: params || {} }))
})

await send('Runtime.enable')
const expression = (text) => new Promise((resolve) => {
  send('Runtime.evaluate', { expression: text, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true, replMode: true })
    .then((message) => {
      const result = message && message.result
      if (!result) return resolve({ error: 'no-result' })
      if (result.exceptionDetails) return resolve({ error: result.exceptionDetails.text || 'exception', detail: String(result.exceptionDetails.exception && result.exceptionDetails.exception.description || '').slice(0, 400) })
      resolve(result.result ? result.result.value : null)
    })
})

const scripts = process.argv.slice(2)
console.log('target: ' + target.title + ' / ' + target.url)
for (const script of scripts) {
  const value = await expression(script)
  console.log('--- ' + script.slice(0, 60) + ' ---')
  console.log(JSON.stringify(value, null, 2).slice(0, 2500))
}
socket.close()
