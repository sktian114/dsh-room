/**
 * 手机浏览器验收：用无头 Chrome 的移动端仿真（视口 / DP / UA / 触摸）
 * 打开真实房间地址，检查「房客用手机加入」这条链路上的每一项。
 *
 *   node test/mobile-ui.mjs [roomUrl] [outDir]
 *   node test/mobile-ui.mjs http://172.16.1.130:8787/ preview/mobile
 *
 * 默认视口 390×844（iPhone 12/13/14 逻辑尺寸），也测 375 / 430 与横屏。
 * 只依赖 Node 内置能力 + 本机 Chrome，不需要装 puppeteer。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const roomUrl = (process.argv[2] || 'http://172.16.1.130:8787/').replace(/\/?$/, '/')
const outDir = resolve(process.argv[3] || 'preview/mobile')
const CDP_PORT = Number(process.env.DSH_ROOM_CDP_PORT || 9411)
const CHROME = process.env.DSH_ROOM_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

mkdirSync(outDir, { recursive: true })
const profileDir = join(tmpdir(), 'dsh-room-mobile-' + process.pid)
rmSync(profileDir, { recursive: true, force: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

const results = []
function record(item, ok, detail) {
  results.push({ item, ok, detail })
  console.log((ok ? 'PASS' : 'FAIL') + '  [' + item + ']  ' + detail)
}

/* ───────────────────────── Chrome + CDP ───────────────────────── */

const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + CDP_PORT,
  '--user-data-dir=' + profileDir,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-extensions',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  'about:blank',
], { stdio: 'ignore', detached: false })

async function waitCdp() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')
      if (r.ok) return await r.json()
    } catch { /* 还没起来 */ }
    await sleep(150)
  }
  throw new Error('Chrome CDP 没起来：' + CHROME)
}
const version = await waitCdp()
console.log('chrome:', version.Browser)

const created = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })).json()
const socket = new WebSocket(created.webSocketDebuggerUrl)
await new Promise((res, rej) => { socket.addEventListener('open', res); socket.addEventListener('error', rej) })
socket.addEventListener('message', () => {})
let nextId = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id)
  if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
  else waiter.resolve(message.result)
})
function send(method, params) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error('eval: ' + JSON.stringify(result.exceptionDetails).slice(0, 400))
  return result.result.value
}
async function waitFor(expression, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try { if (await evaluate(expression)) return true } catch { /* 导航中 */ }
    await sleep(200)
  }
  return false
}
async function shot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(join(outDir, name), Buffer.from(result.data, 'base64'))
  console.log('screenshot', name)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')

async function emulate(width, height, options = {}) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height,
    deviceScaleFactor: options.dp || 3,
    mobile: options.mobile !== false,
    screenWidth: width,
    screenHeight: height,
  })
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  try { await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }) } catch { /* 新版 Chrome 已移除 */ }
  await send('Emulation.setUserAgentOverride', {
    userAgent: options.ua || UA_IPHONE,
    platform: 'iPhone',
    acceptLanguage: 'zh-CN,zh;q=0.9',
  })
}

async function openRoom(width, height, label) {
  await emulate(width, height)
  await send('Page.navigate', { url: roomUrl })
  const ready = await waitFor('document.readyState === "complete" && !!document.body', 20000)
  if (!ready) throw new Error('页面没加载完：' + roomUrl)
  // DSH 是 SPA：等输入框 / 联机按钮出现（最多 25 秒）
  const launched = await waitFor('!!document.querySelector(".dsh-room-launch") || !!document.querySelector("[class*=dsh-room]")', 25000)
  await sleep(1200)
  await shot('m-' + label + '-01-open.png')
  return launched
}

/* ───────────────────────── 1. 环境基线 ───────────────────────── */

await openRoom(390, 844, '390')
const base = await evaluate(`(() => {
  const meta = document.querySelector('meta[name=viewport]');
  const vv = window.visualViewport;
  return {
    url: location.href,
    origin: location.origin,
    secure: window.isSecureContext,
    clipboard: !!(navigator.clipboard && navigator.clipboard.writeText),
    ua: navigator.userAgent,
    dpr: window.devicePixelRatio,
    viewportMeta: meta ? meta.getAttribute('content') : null,
    innerWidth: innerWidth, innerHeight: innerHeight,
    vvWidth: vv && vv.width, vvHeight: vv && vv.height,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    title: document.title,
    boot: !!window.__DSH_BOOT__,
    dark: !!document.querySelector('[data-ds-dark-theme]'),
    hoverNone: matchMedia('(hover:none)').matches,
    anyHover: matchMedia('(any-hover:hover)').matches,
    cookieVisible: document.cookie.length,
  };
})()`)
console.log('baseline:', JSON.stringify(base, null, 2))
record('环境/安全上下文', base.secure === false, 'isSecureContext=' + base.secure + '（http://IP 应为 false）')
record('环境/视口 meta', !!base.viewportMeta && /width=device-width/.test(base.viewportMeta), JSON.stringify(base.viewportMeta))
record('环境/横向溢出(390px)', base.scrollWidth <= 390 + 1, 'scrollWidth=' + base.scrollWidth)
record('环境/DSH 加载', base.boot === true, '__DSH_BOOT__=' + base.boot + ' title=' + base.title)
record('环境/触屏媒体查询', base.hoverNone === true, 'hover:none=' + base.hoverNone)
record('环境/剪贴板 API 可用性', base.clipboard === false, 'navigator.clipboard=' + base.clipboard + '（非 HTTPS 应为 false，必须有 execCommand 兜底）')
record('环境/Cookie 生效', (await evaluate('document.cookie.length >= 0')) && base.title.indexOf('Cookie') === -1, 'title=' + JSON.stringify(base.title))
if (base.title && /Cookie|登录/.test(base.title)) {
  console.log('\n!! 页面是插件的提示页，不是 DSH 本体：', base.title)
}

/* ───────────────────────── 2. DSH 自身窄屏布局 ───────────────────────── */

const layout = await evaluate(`(() => {
  function box(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 };
  }
  const launch = document.querySelector('.dsh-room-launch');
  const composer = document.querySelector('textarea, [contenteditable=true]');
  const input = composer || null;
  // 侧边栏 / 顶栏：DSH 的布局容器不一定有稳定类名，用尺寸与位置启发式
  const sidebar = [...document.querySelectorAll('aside, nav, [class*=sidebar], [class*=Sidebar]')]
    .map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0, 60), ...box(el) }))
    .filter((b) => b.visible);
  const fixed = [...document.querySelectorAll('body *')]
    .filter((el) => { const s = getComputedStyle(el); return s.position === 'fixed' && el.getBoundingClientRect().width >= 320; })
    .slice(0, 6)
    .map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0, 60), ...box(el) }));
  const offscreen = [...document.querySelectorAll('button, input, textarea, [role=button]')]
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1); })
    .map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        cls: String(el.className || '').slice(0, 48),
        text: (el.innerText || el.value || '').trim().slice(0, 16),
        x: Math.round(r.x), right: Math.round(r.right),
        plugin: Boolean(el.closest('.dsh-room-panel, .dsh-room-launch')),
      };
    });
  return {
    dpr: window.devicePixelRatio,
    launch: box(launch),
    launchVisible: launch ? getComputedStyle(launch).display !== 'none' : false,
    composer: box(input),
    inputFontSize: input ? getComputedStyle(input).fontSize : null,
    sidebar, fixed, offscreen,
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: innerHeight,
  };
})()`)
console.log('layout@390:', JSON.stringify(layout, null, 2))
record('DSH 窄屏/联机入口可见', !!layout.launch && layout.launch.visible, JSON.stringify(layout.launch))
record('DSH 窄屏/联机按钮可点尺寸', !!layout.launch && layout.launch.h >= 28 && layout.launch.w >= 60, 'h=' + (layout.launch && layout.launch.h) + ' w=' + (layout.launch && layout.launch.w) + '（触屏建议 ≥44 高）')
record('DSH 窄屏/无横向溢出', (await evaluate('document.documentElement.scrollWidth <= innerWidth + 1')), 'scrollWidth=' + base.scrollWidth)
record('DSH 窄屏/插件控件不越界', layout.offscreen.filter((item) => item.plugin).length === 0, '插件越界控件=' + layout.offscreen.filter((item) => item.plugin).length + '；DSH 自身越界控件=' + layout.offscreen.filter((item) => !item.plugin).length + ' ' + JSON.stringify(layout.offscreen.filter((item) => !item.plugin).slice(0, 4)))
record('DSH 窄屏/侧边栏', layout.sidebar.length === 0 || layout.sidebar.every((b) => b.w < 390 * 0.9), JSON.stringify(layout.sidebar.map((b) => b.w)))

/* ───────────────────────── 3. 面板：尺寸 / dvh / 触屏 ───────────────────────── */

// 访客经房主地址打开时，插件应自动加入房间并把面板摊开当「房间页」
const autoPanel = await evaluate(`!!document.querySelector('.dsh-room-panel')`)
if (!autoPanel) {
  const clicked = await evaluate(`(() => {
    const button = document.querySelector('.dsh-room-launch');
    if (!button) return 'no-button';
    button.click();
    return 'ok';
  })()`)
  if (clicked !== 'ok') console.log('!! 没找到联机按钮')
}
await sleep(900)
await shot('m-390-02-panel.png')

const panel = await evaluate(`(() => {
  const el = document.querySelector('.dsh-room-panel');
  if (!el) return { missing: true };
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return {
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) },
    maxHeight: s.maxHeight, bottomCss: s.bottom, rightCss: s.right, position: s.position,
    inlineMaxh: el.style.getPropertyValue('--room-maxh'),
    scrollable: el.scrollHeight > el.clientHeight,
    bodyScrollable: (() => { const b = el.querySelector('.dsh-room-body'); return b ? b.scrollHeight > b.clientHeight : null; })(),
    viewportHeight: innerHeight,
    visualHeight: window.visualViewport ? Math.round(window.visualViewport.height) : null,
    overflowingBottom: r.bottom > innerHeight + 1,
    overflowingTop: r.top < -1,
    withinWidth: r.left >= -1 && r.right <= innerWidth + 1,
    tabIndex: [...el.querySelectorAll('.dsh-room-tab')].map((t) => ({ text: t.innerText.trim(), h: Math.round(t.getBoundingClientRect().height), active: t.getAttribute('data-active') === 'true' })),
    activeTab: (() => { const t = el.querySelector('.dsh-room-tab[data-active=true]'); return t ? t.innerText.trim() : null; })(),
    kickDisplay: [...el.querySelectorAll('.dsh-room-kick')].map((k) => getComputedStyle(k).display),
    fontSize: s.fontSize,
    closeSize: (() => { const c = el.querySelector('.dsh-room-iconbtn'); if (!c) return null; const b = c.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; })(),
    memberRows: [...el.querySelectorAll('.dsh-room-member')].map((m) => (m.innerText || '').trim().replace(/\\s+/g, ' ')),
    hasError: !!el.querySelector('.dsh-room-error'),
    errorText: (() => { const e = el.querySelector('.dsh-room-error'); return e ? e.innerText.trim() : null; })(),
    bodyText: (el.querySelector('.dsh-room-body') || el).innerText.slice(0, 260).replace(/\\s+/g, ' '),
    launchSize: (() => { const l = document.querySelector('.dsh-room-launch'); if (!l) return null; const b = l.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; })(),
    styleHasDvh: (() => { const s2 = document.getElementById('dsh-room-style'); return s2 ? /100dvh/.test(s2.textContent) : false; })(),
    styleHasTouch: (() => { const s2 = document.getElementById('dsh-room-style'); return s2 ? /hover:none/.test(s2.textContent) : false; })(),
    styleHasIosFont: (() => { const s2 = document.getElementById('dsh-room-style'); return s2 ? /font-size: 16px|font-size:16px/.test(s2.textContent) : false; })(),
  };
})()`)
console.log('panel@390:', JSON.stringify(panel, null, 2))
record('面板/已打开', !panel.missing, JSON.stringify(panel.rect || null))
record('面板/访客自动加入后默认落在访客页签', panel.activeTab === '访客', 'activeTab=' + panel.activeTab + ' tabs=' + JSON.stringify(panel.tabIndex))
record('面板/没有房主专属报错', panel.hasError === false, 'errorText=' + JSON.stringify(panel.errorText))
record('面板/成员列表已包含自己', Array.isArray(panel.memberRows) && panel.memberRows.length >= 2, JSON.stringify(panel.memberRows))
record('面板/同一台手机不会重复加入', (() => {
  const names = (panel.memberRows || [])
    .map((row) => String(row).split(' ').filter(Boolean))
    .filter((parts) => parts.length >= 2 && parts[parts.length - 1] !== '房主')
    .map((parts) => parts[parts.length - 2])
  return new Set(names).size === names.length
})(), JSON.stringify(panel.memberRows))
record('面板/不超出视口底部', !!panel.rect && !panel.overflowingBottom, 'bottom=' + (panel.rect && panel.rect.bottom) + ' innerHeight=' + (panel.viewportHeight))
record('面板/不超出视口顶部', !!panel.rect && !panel.overflowingTop, 'top=' + (panel.rect && panel.rect.y))
record('面板/不超出视口宽度', !!panel.rect && panel.withinWidth, 'left=' + (panel.rect && panel.rect.x) + ' right=' + (panel.rect && panel.rect.right))
record('面板/高度用了 dvh', panel.styleHasDvh === true, 'stylesheet 含 100dvh=' + panel.styleHasDvh + ' max-height=' + panel.maxHeight)
record('面板/tab 触屏可点', Array.isArray(panel.tabIndex) && panel.tabIndex.every((t) => t.h >= 28), JSON.stringify(panel.tabIndex))
record('面板/关窗按钮触屏可点', !!panel.closeSize && panel.closeSize.w >= 30 && panel.closeSize.h >= 30, JSON.stringify(panel.closeSize))
record('面板/触屏样式存在', panel.styleHasTouch === true, 'hover:none 规则=' + panel.styleHasTouch)
record('面板/手机输入字号 16px', panel.styleHasIosFont === true, 'stylesheets 含 16px 规则=' + panel.styleHasIosFont)

// 复制兜底：headless 里 execCommand('copy') 返回 false，应弹出可长按的兜底面板
const copyProbe = await evaluate(`(async () => {
  const el = document.querySelector('.dsh-room-panel');
  const ghost = el ? [...el.querySelectorAll('.dsh-room-ghost')].find((b) => /复制地址|复制邀请/.test(b.innerText || '')) : null;
  if (!ghost) return { clicked: false, reason: 'no-copy-button', panelText: el ? el.innerText.slice(0,120) : '' };
  ghost.click();
  await new Promise((r) => setTimeout(r, 700));
  const fb = document.getElementById('dsh-room-copyfallback');
  return {
    clicked: true,
    fallbackShown: !!fb,
    fallbackText: fb ? (fb.querySelector('.dsh-room-copyfallback-text') || {}).value : null,
    selectedLength: fb ? String(document.getSelection() || '').length : 0,
  };
})()`)
console.log('copy fallback:', JSON.stringify(copyProbe))
record('剪贴板/失败时弹出长按复制面板', copyProbe.fallbackShown === true, JSON.stringify(copyProbe))
if (copyProbe.fallbackShown) {
  await shot('m-390-05-copy-fallback.png')
  await evaluate(`(() => { const b = document.querySelector('.dsh-room-copyfallback-close'); if (b) b.click(); })()`)
}

// 模拟 iOS 地址栏收放：视口高度变化（844 → 750），面板应重新贴合
await emulationHeight(390, 750)
await sleep(600)
const afterResize = await evaluate(`(() => {
  const el = document.querySelector('.dsh-room-panel');
  const r = el.getBoundingClientRect();
  return { bottom: Math.round(r.bottom), h: Math.round(r.height), innerHeight: innerHeight, maxHeight: getComputedStyle(el).maxHeight };
})()`)
console.log('panel after address-bar shrink:', JSON.stringify(afterResize))
record('面板/视口收缩后不越界', afterResize.bottom <= 750 + 1, JSON.stringify(afterResize))
await emulate(390, 844)
await sleep(400)

/* ───────────────────────── 4. 剪贴板兜底（非 HTTPS） ───────────────────────── */

const clip = await evaluate(`(() => {
  const report = { clipboardApi: !!(navigator.clipboard && navigator.clipboard.writeText), secure: window.isSecureContext, execCommand: typeof document.execCommand === 'function' };
  // 模拟 copyText 的兜底分支：textarea + select + execCommand
  try {
    const area = document.createElement('textarea');
    area.value = 'http://172.16.1.130:8787';
    area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.appendChild(area);
    area.select(); area.setSelectionRange(0, area.value.length);
    report.execResult = document.execCommand('copy');
    report.selectionLength = String(getSelection() || '').length;
    document.body.removeChild(area);
  } catch (error) { report.error = String(error); }
  return report;
})()`)
console.log('clipboard:', JSON.stringify(clip))
record('剪贴板/非 HTTPS 有兜底路径', clip.clipboardApi === false && clip.execCommand === true, JSON.stringify(clip))

/* ───────────────────────── 5. 375 / 430 / 横屏 ───────────────────────── */

// 同一个页面里改设备指标触发重排：不重新导航（避免重复握手并打乱握手限流）
for (const [w, h, label] of [[375, 667, '375'], [430, 932, '430'], [844, 390, 'land']]) {
  await emulate(w, h)
  await sleep(900)
  const openNow = await evaluate(`!!document.querySelector('.dsh-room-panel')`)
  if (openNow) {
    await evaluate(`(() => { const b = document.querySelector('.dsh-room-iconbtn'); if (b) b.click(); })()`)
    await sleep(400)
  }
  await shot('m-' + label + '-01-open.png')
  const probe = await evaluate(`(() => {
    const overflowX = document.documentElement.scrollWidth > innerWidth + 1;
    const button = document.querySelector('.dsh-room-launch');
    const r = button ? button.getBoundingClientRect() : null;
    if (button) button.click();
    return { w: innerWidth, h: innerHeight, overflowX, button: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null };
  })()`)
  await sleep(700)
  await shot('m-' + label + '-02-panel.png')
  const panelBox = await evaluate(`(() => { const el = document.querySelector('.dsh-room-panel'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), innerHeight: innerHeight, maxHeight: getComputedStyle(el).maxHeight }; })()`)
  console.log('viewport ' + w + '×' + h + ':', JSON.stringify({ probe, panelBox }))
  record('视口 ' + w + '×' + h + '/无横向溢出', !probe.overflowX, 'scrollWidth=' + probe.w)
  record('视口 ' + w + '×' + h + '/面板不越界', !!panelBox && panelBox.bottom <= panelBox.innerHeight + 1 && panelBox.y >= -1 && panelBox.x >= -1 && panelBox.x + panelBox.w <= w + 1, JSON.stringify(panelBox))
}

/* ───────────────────────── 6. 访客首屏（房间页/成员入口） ───────────────────────── */

await emulate(390, 844)
await sleep(700)
const openNow = await evaluate(`!!document.querySelector('.dsh-room-panel')`)
if (openNow) {
  await evaluate(`(() => { const b = document.querySelector('.dsh-room-iconbtn'); if (b) b.click(); })()`)
  await sleep(400)
}
await shot('m-390-03-first-screen.png')
const first = await evaluate(`(() => {
  const launch = document.querySelector('.dsh-room-launch');
  const lr = launch ? launch.getBoundingClientRect() : null;
  const links = [...document.querySelectorAll('a')].map((a) => ({ text: (a.innerText || '').trim().slice(0, 24), href: a.href })).filter((a) => a.text);
  return {
    title: document.title,
    hasRoomPage: !!document.querySelector('[data-dsh-room-page]'),
    launchInViewport: lr ? (lr.top >= 0 && lr.bottom <= innerHeight && lr.left >= 0) : false,
    launchRect: lr ? { x: Math.round(lr.x), y: Math.round(lr.y), w: Math.round(lr.width), h: Math.round(lr.height) } : null,
    links: links.slice(0, 10),
    footerHasRoomText: document.body.innerText.indexOf('房间') >= 0,
  };
})()`)
console.log('first screen:', JSON.stringify(first, null, 2))
record('首屏/联机入口在视口内', first.launchInViewport === true, JSON.stringify(first.launchRect))
record('首屏/无独立房间页', first.hasRoomPage === false, 'hasRoomPage=' + first.hasRoomPage + '（当前实现直接进 DSH，没有房间落地页）')

// 访客打开面板时默认落在哪个 tab、会不会把房主专属接口的报错摊给访客
const guestPanel = await evaluate(`(() => {
  const launch = document.querySelector('.dsh-room-launch');
  if (!launch) return null;
  launch.click();
  return true;
})()`)
await sleep(700)
await shot('m-390-04-guest-panel.png')
const guestTabProbe = await evaluate(`(() => {
  const el = document.querySelector('.dsh-room-panel');
  if (!el) return null;
  const tabs = [...el.querySelectorAll('.dsh-room-tab')].map((t) => ({ text: t.innerText.trim(), active: t.getAttribute('data-active') }));
  const joinInput = el.querySelector('.dsh-room-join-input');
  const error = el.querySelector('.dsh-room-error');
  const bodyEl = el.querySelector('.dsh-room-body') || el;
  return {
    tabs,
    hostError: error ? error.innerText.trim() : null,
    joinInputValue: joinInput ? joinInput.value : null,
    origin: location.origin,
    bodyText: bodyEl.innerText.slice(0, 260).replace(/\\s+/g, ' '),
    hasWorkbenchButton: /进入房主工作台/.test(bodyEl.innerText),
    saysAlreadyHere: /已经在房间里/.test(bodyEl.innerText),
    launchTitle: (document.querySelector('.dsh-room-launch') || {}).title || '',
  };
})()`)
console.log('guest panel:', JSON.stringify(guestTabProbe, null, 2))
if (guestTabProbe) {
  record('访客/面板默认落在「访客」页签', !(guestTabProbe.tabs[0] && guestTabProbe.tabs[0].active === 'true'), JSON.stringify(guestTabProbe.tabs))
  record('访客/不再显示房主专属报错', !guestTabProbe.hostError, 'hostError=' + JSON.stringify(guestTabProbe.hostError))
  record('访客/已在本页工作台时不再劝跳转', guestTabProbe.saysAlreadyHere === true && guestTabProbe.hasWorkbenchButton === false, JSON.stringify({ saysAlreadyHere: guestTabProbe.saysAlreadyHere, button: guestTabProbe.hasWorkbenchButton }))
  record('访客/已加入后不再要求输入地址', guestTabProbe.joinInputValue === null, 'joinInput=' + JSON.stringify(guestTabProbe.joinInputValue))
  record('访客/联机按钮标题显示房间身份', /已在房间里/.test(guestTabProbe.launchTitle), 'title=' + JSON.stringify(guestTabProbe.launchTitle))
}

/* ───────────────────────── 7. 掉线自动重入 ─────────────────────────
   手机切后台后浏览器会冻结定时器，超过服务端 MEMBER_TTL 就会被清理——用户看到的是
   「房主那边看不到我 / 我自己成员变 0」。这里用 /leave 强制清理来等价模拟，再派发
   visibilitychange + pageshow（切回前台），验证客户端会带着旧昵称静默重新入房。 */
console.log('\nsection: 掉线自动重入')
const apiBase = roomUrl.replace(/\/+$/, '')
const guestBefore = await evaluate(`(() => {
  try { return JSON.parse(localStorage.getItem('dsh-room.guest') || 'null') } catch (error) { return null }
})()`)
if (guestBefore && guestBefore.token) {
  const leaveRes = await fetch(apiBase + '/room/api/leave?token=' + encodeURIComponent(guestBefore.token), { method: 'POST' })
  const leaveJson = await leaveRes.json().catch(() => null)
  record('重入/强制清理生效', Boolean(leaveJson && leaveJson.ok), 'status=' + leaveRes.status + ' body=' + JSON.stringify(leaveJson))

  const staleRes = await fetch(apiBase + '/room/api/state?token=' + encodeURIComponent(guestBefore.token))
  const staleJson = await staleRes.json().catch(() => null)
  // stale 标记由新版宿主提供（重启用）；客户端只要看到 401 就会重入，所以这里按 401 判定
  record('重入/失效令牌返回 401', staleRes.status === 401, 'status=' + staleRes.status + ' stale=' + String(Boolean(staleJson && staleJson.stale)))

  // 模拟「切后台再切回来」：移动端就是这两个事件
  await evaluate(`(() => {
    try { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }) } catch (error) { /* 旧浏览器 */ }
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pageshow'))
    return true
  })()`)
  await sleep(2500)

  const after = await evaluate(`(async () => {
    let guest = null
    try { guest = JSON.parse(localStorage.getItem('dsh-room.guest') || 'null') } catch (error) { guest = null }
    if (!guest || !guest.token) return { guest: null }
    const res = await fetch(guest.addr + '/room/api/state?token=' + encodeURIComponent(guest.token))
    const body = await res.json().catch(() => null)
    return { guest, status: res.status, ok: Boolean(body && body.ok), members: (body && body.members) || [] }
  })()`)
  console.log('rejoin after foreground:', JSON.stringify(after, null, 2))
  record('重入/回到前台自动重新入房', Boolean(after && after.ok), 'status=' + String(after && after.status) + ' tokenChanged=' + String(Boolean(after && after.guest && after.guest.token !== guestBefore.token)))
  record('重入/仍然用原昵称', Boolean(after && after.guest && after.guest.name === guestBefore.name), 'name=' + JSON.stringify(after && after.guest && after.guest.name))
  record('重入/成员列表恢复（不再为 0）', Boolean(after && after.members.length >= 2), 'members=' + JSON.stringify((after && after.members || []).map((m) => m.name)))
} else {
  record('重入/拿到访客令牌', false, JSON.stringify(guestBefore))
}

writeFileSync(join(outDir, 'report.json'), JSON.stringify({ roomUrl, version: version.Browser, baseline: base, layout, panel, clip, first, results }, null, 2))
console.log('\nreport →', join(outDir, 'report.json'))

/* ───────────────────────── 收尾 ───────────────────────── */

async function emulationHeight(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 3, mobile: true, screenWidth: width, screenHeight: height })
}

socket.close()
try { chrome.kill() } catch { /* 忽略 */ }
await sleep(1500)
try {
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 })
} catch (error) {
  console.log('（临时目录留给系统清理：' + profileDir + '）')
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + (failed.length ? 'FAILED ' + failed.length + ' / ' + results.length : 'ALL PASS ' + results.length))
if (failed.length) for (const f of failed) console.log(' - [' + f.item + '] ' + f.detail)
process.exit(failed.length ? 1 : 0)
