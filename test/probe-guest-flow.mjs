/**
 * 完整模拟一个真房客浏览器：先走 HTML 引导拿 DSH 自己的登录 cookie，
 * 再拉会话列表（代理会给守卫「补课」），最后发一条指令。
 *
 * 用法：node test/probe-guest-flow.mjs [--room=http://172.16.1.130:8787] [--name=命令行访客]
 */
const args = new Map()
for (const arg of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(arg)
  if (m) args.set(m[1], m[2])
}
const room = (args.get('room') || 'http://172.16.1.130:8787').replace(/\/$/, '')
const name = args.get('name') || '命令行访客'
const jar = new Map()

function cookieHeader() {
  return [...jar.entries()].map(([key, value]) => key + '=' + value).join('; ')
}
function absorb(response) {
  const list = response.headers.getSetCookie ? response.headers.getSetCookie() : []
  for (const raw of list) {
    const pair = raw.split(';')[0]
    const at = pair.indexOf('=')
    if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
  }
}

// 1) 加入房间
const joined = await (await fetch(room + '/room/api/join', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.9' },
  body: JSON.stringify({ name }),
})).json()
console.log('1) join: ok=' + joined.ok + ' token=' + String(joined.token).slice(0, 8) + '…')
jar.set('dsh_room_token', joined.token)

// 2) 打开首页（HTML 引导：代理跳一次带 token 的地址，DSH 会下发自己的 cookie）
//    undici 的 fetch 没有 cookie 罐，必须手动跟随并逐跳收 Set-Cookie。
let url = room + '/'
let pageStatus = 0
for (let hop = 0; hop < 6; hop += 1) {
  const response = await fetch(url, { headers: { accept: 'text/html', cookie: cookieHeader() }, redirect: 'manual' })
  absorb(response)
  pageStatus = response.status
  if (response.status >= 300 && response.status < 400) {
    const next = response.headers.get('location') || ''
    await response.text()
    url = next.startsWith('http') ? next : new URL(next, url).toString()
    continue
  }
  break
}
console.log('2) 首页: status=' + pageStatus + ' cookies=' + JSON.stringify([...jar.keys()]))

// 3) 拉会话列表（房客的 session/list 由代理改写 + 给守卫补课）
const listResponse = await fetch(room + '/api/session/list', {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: cookieHeader(), 'x-forwarded-for': '198.51.100.9' },
  body: JSON.stringify({ type: 'client-request', rpcId: 'r-list-1', method: 'session/list', payload: { args: {} } }),
})
absorb(listResponse)
const listText = await listResponse.text()
let items = []
try { items = JSON.parse(listText).result?.value?.items || [] } catch { /* 忽略 */ }
console.log('3) session/list: status=' + listResponse.status + ' raw=' + listText.slice(0, 500) + ' ' + ' 条数=' + items.length
  + (items[0] ? ' 首条 keys=' + JSON.stringify(Object.keys(items[0])) : '')
  + (listResponse.status !== 200 ? ' 片段=' + listText.slice(0, 120) : ''))

const first = items[0] || null
const cwd = first ? (first.cwd || first.projections?.values?.workingDirectory || '') : ''
const sessionId = first ? (first.sessionId || first.projections?.values?.sessionId || '') : ''
console.log('   首条: session=' + String(sessionId).slice(0, 20) + ' cwd=' + cwd)

// 3b) 对照：同一个 DSH cookie 直接打宿主端口，看 DSH 自己怎么回（区分是代理改写还是 DSH 就没给）
if (args.get('dsh')) {
  const direct = await fetch(args.get('dsh').replace(/\/$/, '') + '/api/session/list', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader() },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r-list-2', method: 'session/list', payload: { args: {} } }),
  })
  const directText = await direct.text()
  let directCount = -1
  try { directCount = (JSON.parse(directText).result?.value?.items || []).length } catch { /* 忽略 */ }
  console.log('3b) 直连宿主 session/list: status=' + direct.status + ' 条数=' + directCount + ' 片段=' + directText.slice(0, 160))
}

// 4) 发指令
if (sessionId) {
  const promptResponse = await fetch(room + '/api/session/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader() },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'r-prompt-1',
      method: 'session/prompt',
      payload: {
        args: {
          request: {
            requestId: 'q-1',
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: '〔@' + name + '〕\n开发发送验证 ' + Date.now() }],
          },
        },
      },
    }),
  })
  const text = await promptResponse.text()
  console.log('4) session/prompt: status=' + promptResponse.status + ' → ' + text.slice(0, 260))
} else {
  console.log('4) 没有可发的会话，跳过')
}

