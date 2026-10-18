/**
 * 在真实 DSH 页面里通过 CDP 验收界面：
 *   · 找到「联机」按钮，量尺寸/颜色
 *   · 点开面板，截图并读取样式（浅色 / 深色）
 *   · 切到访客 tab、验证点外部 / Esc 关闭
 *   · 模拟访客加入后重新打开，验证已加入视图
 * 用法：node test/live-ui.mjs <cdpPort> <roomUrl> <outDir>
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const port = process.argv[2] || '9334'
const roomUrl = process.argv[3] || 'http://127.0.0.1:18797/'
const outDir = process.argv[4] || 'preview'
const joinCode = process.argv[5] || ''
mkdirSync(outDir, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 先以房客身份加入一次，拿到 token（Node 侧请求，不受 CORS 影响）
let guest = null
try {
  const ping = await (await fetch(roomUrl + 'room/api/ping')).json()
  const joined = await (await fetch(roomUrl + 'room/api/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '阿伟', code: joinCode }),
  })).json()
  if (joined && joined.ok) guest = { addr: roomUrl.replace(/\/$/, ''), token: joined.token, name: '阿伟' }
  console.log('guest join:', joined && joined.ok ? 'ok' : JSON.stringify(joined), 'needsCode=' + ping.needsCode)
} catch (error) {
  console.log('guest join failed:', error.message)
}

const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
const page = targets.find((target) => target.type === 'page')
if (!page) throw new Error('no page target')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})
let nextId = 0
function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    function onMessage(event) {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      socket.removeEventListener('message', onMessage)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function waitFor(expression, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      if (await evaluate(expression)) return true
    } catch (error) { /* 导航中 */ }
    await sleep(350)
  }
  return false
}
async function shot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(join(outDir, name), Buffer.from(result.data, 'base64'))
  console.log('screenshot', name)
}
async function clickText(text) {
  return evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === ${JSON.stringify(text)});
    if (!el) return false;
    el.click();
    return true;
  })()`)
}
async function openPanel() {
  await evaluate("document.querySelector('.dsh-room-launch').click()")
  return waitFor("!!document.querySelector('.dsh-room-panel')", 4000)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false })
await send('Page.navigate', { url: roomUrl })
const ready = await waitFor("document.readyState === 'complete' && !!document.querySelector('.dsh-room-launch')", 30000)
if (!ready) {
  const state = await evaluate("JSON.stringify({ ready: document.readyState, body: (document.body.innerText||'').slice(0,300) })")
  console.log('button not found', state)
  await shot('live-missing.png')
  socket.close()
  process.exit(2)
}
await sleep(1200)
await clickText('继续')
await sleep(700)

const buttonInfo = await evaluate(`(() => {
  const el = document.querySelector('.dsh-room-launch');
  const rect = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return JSON.stringify({
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    text: el.innerText, fontSize: cs.fontSize, radius: cs.borderRadius,
    color: cs.color, background: cs.backgroundColor,
    live: el.getAttribute('data-live'), open: el.getAttribute('data-open'),
    tokenPrimary: getComputedStyle(document.body).getPropertyValue('--dsw-alias-label-primary').trim(),
    styleHasNewCss: (document.getElementById('dsh-room-style') || { textContent: '' }).textContent.includes('dsh-room-note'),
  }, null, 2);
})()`)
console.log('BUTTON', buttonInfo)
await shot('live-1.png')

if (!(await openPanel())) {
  console.log('panel did not open')
  socket.close()
  process.exit(3)
}
await sleep(500)

const panelInfo = await evaluate(`(() => {
  const panel = document.querySelector('.dsh-room-panel');
  const rect = panel.getBoundingClientRect();
  const cs = getComputedStyle(panel);
  const tabs = [...panel.querySelectorAll('.dsh-room-tab')].map((el) => ({ text: el.innerText, active: el.getAttribute('data-active'), color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }));
  const addrs = [...panel.querySelectorAll('.dsh-room-addr-text')].map((el) => el.innerText);
  const labels = [...panel.querySelectorAll('.dsh-room-addr-tag')].map((el) => el.innerText);
  return JSON.stringify({
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    radius: cs.borderRadius, background: cs.backgroundColor, color: cs.color, border: cs.borderTopWidth,
    boxShadow: cs.boxShadow.slice(0, 90), title: panel.querySelector('.dsh-room-title').innerText,
    status: panel.querySelector('.dsh-room-status-title').innerText,
    statusSub: panel.querySelector('.dsh-room-status-sub').innerText,
    memberNames: [...panel.querySelectorAll('.dsh-room-mname')].map((el) => el.innerText),
    addrs, labels, tabs,
    indicator: (() => { const el = panel.querySelector('.dsh-room-tab-indicator'); return el ? getComputedStyle(el).transform : null })(),
    bodyScroll: (() => { const b = panel.querySelector('.dsh-room-body'); return { h: b.clientHeight, sh: b.scrollHeight } })(),
  }, null, 2);
})()`)
console.log('PANEL', panelInfo)
await shot('live-2.png')

// 复制邀请 → toast
await clickText('复制邀请')
await sleep(300)
const toastInfo = await evaluate(`(() => {
  const el = document.querySelector('.dsh-room-toast');
  return JSON.stringify({ exists: !!el, show: el && el.getAttribute('data-show'), text: el && el.innerText });
})()`)
console.log('TOAST', toastInfo)
await shot('live-2b-toast.png')

// 访客 tab
await clickText('访客')
await sleep(450)
console.log('TAB-INDICATOR', await evaluate("getComputedStyle(document.querySelector('.dsh-room-tab-indicator')).transform"))
await shot('live-3-guest-form.png')
const guestForm = await evaluate(`(() => {
  const input = document.querySelector('.dsh-room-join-input');
  const cs = input ? getComputedStyle(input) : null;
  return JSON.stringify({ placeholder: input && input.placeholder, value: input && input.value, focused: document.activeElement === input, border: cs && cs.borderTopColor });
})()`)
console.log('GUEST-FORM', guestForm)

// 点外部关闭
await evaluate("document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))")
await sleep(300)
console.log('closed-by-outside:', await evaluate("!document.querySelector('.dsh-room-panel')"))

// Esc 关闭
await openPanel()
await sleep(300)
await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
await sleep(300)
console.log('closed-by-escape:', await evaluate("!document.querySelector('.dsh-room-panel')"))

// 访客已加入视图：写入 localStorage 后重载
if (guest) {
  await evaluate(`localStorage.setItem('dsh-room.guest', ${JSON.stringify(JSON.stringify(guest))}); true`)
  await send('Page.reload', { ignoreCache: true })
  await waitFor("document.readyState === 'complete' && !!document.querySelector('.dsh-room-launch')", 30000)
  await sleep(1200)
  await clickText('继续')
  await sleep(500)
  await openPanel()
  await sleep(600)
  await clickText('访客')
  await sleep(1200)
  const joinedInfo = await evaluate(`(() => {
    const panel = document.querySelector('.dsh-room-panel');
    return JSON.stringify({
      hasPanel: !!panel,
      status: panel && panel.querySelector('.dsh-room-status-sub') ? panel.querySelector('.dsh-room-status-sub').innerText : null,
      cta: panel && panel.querySelector('.dsh-room-btn.primary') ? panel.querySelector('.dsh-room-btn.primary').innerText : null,
      members: panel ? [...panel.querySelectorAll('.dsh-room-mname')].map((el) => el.innerText) : [],
      latency: panel && panel.querySelector('.dsh-room-status-sub') ? /延迟 \\d+ms/.test(panel.querySelector('.dsh-room-status-sub').innerText) : false,
    }, null, 2);
  })()`)
  console.log('GUEST-JOINED', joinedInfo)
  await shot('live-4-guest-joined.png')

  // 深色
  await evaluate("document.body.setAttribute('data-ds-dark-theme', ''); document.documentElement.style.colorScheme = 'dark';")
  await sleep(600)
  await shot('live-5-dark.png')
}

socket.close()
