/**
 * 挂到 DSH inspector（默认 127.0.0.1:9230），实时打印宿主域的 console / log / 异常。
 * 用法：node inspector-logs.mjs [秒数]
 */
const endpoint = process.env.DSH_INSPECTOR || 'http://127.0.0.1:9230'
const seconds = Number(process.argv[2] || 20)

const list = await (await fetch(endpoint + '/json/list')).json()
const target = list.find((item) => item.webSocketDebuggerUrl)
const socket = new WebSocket(target.webSocketDebuggerUrl)
let seq = 0
const send = (method, params) => socket.send(JSON.stringify({ id: ++seq, method, params: params || {} }))

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

socket.addEventListener('message', (event) => {
  let message = null
  try { message = JSON.parse(String(event.data)) } catch { return }
  if (message.method === 'Runtime.consoleAPICalled') {
    const args = (message.params.args || []).map((arg) => {
      if (arg.value !== undefined) return String(arg.value)
      if (arg.description) return String(arg.description)
      return arg.type
    })
    console.log('[console.' + message.params.type + '] ' + args.join(' ').slice(0, 1200))
  } else if (message.method === 'Log.entryAdded') {
    const entry = message.params.entry || {}
    console.log('[log.' + entry.level + '] ' + String(entry.text || '').slice(0, 1200))
  } else if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails || {}
    console.log('[exception] ' + String(details.text || '') + ' ' + String(details.exception && details.exception.description || '').slice(0, 800))
  }
})

send('Runtime.enable')
send('Log.enable')
console.log('已挂上，监听 ' + seconds + ' 秒…')
await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
socket.close()
console.log('结束')
