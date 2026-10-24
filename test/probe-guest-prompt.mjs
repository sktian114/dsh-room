/**
 * 验证「房客的指令能不能进到会话里」，以及打标链路：
 *   1) 以房客身份加入房间（拿 token / cookie）
 *   2) 通过房间代理 POST /api/session/prompt（源 IP 走网卡地址 → 真·房客路径）
 *   3) 打印响应，交给上层去核对会话日志里有没有这条消息 / 有没有标记
 *
 * 用法：node test/probe-guest-prompt.mjs --room=http://172.16.1.130:8787 --session=<sessionId> [--name=命令行访客] [--mark]
 */
const args = new Map()
for (const arg of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(arg)
  if (m) args.set(m[1], m[2])
  else if (/^--[^=]+$/.test(arg)) args.set(arg.slice(2), '')
}
const room = (args.get('room') || 'http://172.16.1.130:8787').replace(/\/$/, '')
const sessionId = args.get('session') || ''
const name = args.get('name') || '命令行访客'
const mark = args.has('mark')
const text = args.get('text') || '打标验证消息 ' + Date.now()

const joined = await (await fetch(room + '/room/api/join', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name }),
})).json()
if (!joined || !joined.ok) {
  console.log(JSON.stringify({ step: 'join', ok: false, joined }, null, 2))
  process.exit(1)
}
const cookie = 'dsh_room_token=' + joined.token

/** 先像真页面那样拉一次会话列表：代理会顺手把「会话 → 工作区路径」记进守卫。 */
const listBody = {
  type: 'client-request',
  rpcId: 'r-list-' + Date.now(),
  method: 'session/list',
  payload: { args: {} },
}
const listResponse = await fetch(room + '/api/session/list', {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(listBody),
})
const listText = await listResponse.text()
let listed = []
try {
  const parsed = JSON.parse(listText)
  const items = parsed && parsed.result && parsed.result.value && parsed.result.value.items
  listed = Array.isArray(items) ? items : []
} catch { /* 忽略 */ }
const firstItem = listed[0] || null
const cwdOf = (item) => (item && (item.cwd
  || (item.projections && item.projections.values && item.projections.values.workingDirectory))) || ''
const targetSession = sessionId || (firstItem && (firstItem.sessionId
  || (firstItem.projections && firstItem.projections.values && firstItem.projections.values.sessionId))) || ''
console.log(JSON.stringify({
  step: 'list',
  status: listResponse.status,
  count: listed.length,
  target: targetSession,
  firstItemKeys: firstItem ? Object.keys(firstItem) : [],
  firstItemCwd: cwdOf(firstItem),
  snippet: listText.slice(0, 160),
}, null, 2))

const body = {
  type: 'client-request',
  rpcId: 'r-probe-' + Date.now(),
  method: 'session/prompt',
  payload: {
    args: {
      request: {
        requestId: 'q-' + Date.now(),
        sessionId: targetSession,
        mode: 'queue',
        content: [{ type: 'text', text: mark ? '〔@' + name + '〕\n' + text : text }],
      },
    },
  },
}
const response = await fetch(room + '/api/session/prompt', {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
})
const answer = await response.text()
console.log(JSON.stringify({
  step: 'prompt',
  join: { self: joined.self, token: joined.token.slice(0, 8) + '…' },
  sentText: body.payload.args.request.content[0].text.slice(0, 60),
  status: response.status,
  answer: answer.slice(0, 400),
}, null, 2))
