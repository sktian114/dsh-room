/**
 * 诊断：为什么某些浏览器配置里房客页白屏（界面没挂载）。
 *
 * 用法：
 *   node test/probe-blank.mjs --profile=<chrome user-data-dir> --url=http://192.168.1.5:8787/ [--wait=9000]
 *
 * 做三件事：
 *   1) 拿 CDP 连上页面，等 N 秒；
 *   2) 读 DOM / localStorage 键名 / 已加载的 script 地址；
 *   3) 读 performance 里的资源条目，把 HTTP 状态不是 2xx/304 的挑出来 —— 谁挂了就是它。
 *
 * 只读诊断，不改页面。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = new Map()
for (const arg of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(arg)
  if (m) args.set(m[1], m[2])
  else if (/^--[^=]+$/.test(arg)) args.set(arg.slice(2), '')
}
const profile = args.get('profile') || mkdtempSync(join(tmpdir(), 'probe-blank-'))
const url = args.get('url') || 'http://192.168.1.5:8787/'
const waitMs = Number(args.get('wait') || 9000)
const port = Number(args.get('port') || 9333)
const keep = args.has('keep')

const CHROME = args.get('chrome') || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--window-size=1440,900',
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
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (reply.error) return { error: reply.error.message }
  const result = reply.result && reply.result.result
  if (reply.result && reply.result.exceptionDetails) {
    return { error: reply.result.exceptionDetails.text || 'exception' }
  }
  return result ? result.value : null
}

await send('Runtime.enable')

// --trace：开网络与异常监听，然后重载一次，把失败项全部录下来
const trace = { failed: [], bad: [], exceptions: [], logs: [], console: [] }
if (args.has('trace')) {
  await send('Network.enable')
  await send('Log.enable')
  socket.addEventListener('message', (event) => {
    let payload
    try { payload = JSON.parse(event.data) } catch { return }
    const m = payload.method
    if (!m) return
    if (m === 'Network.loadingFailed' && trace.failed.length < 20) {
      trace.failed.push({ url: String(payload.params.url || '').slice(-130), error: payload.params.errorText, type: payload.params.type })
    }
    if (m === 'Network.responseReceived' && payload.params.response.status >= 400 && trace.bad.length < 20) {
      trace.bad.push({ url: String(payload.params.response.url).slice(-130), status: payload.params.response.status })
    }
    if (m === 'Runtime.exceptionThrown' && trace.exceptions.length < 12) {
      const d = payload.params.exceptionDetails
      trace.exceptions.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text || '').slice(0, 300))
    }
    if (m === 'Log.entryAdded' && payload.params.entry.level === 'error' && trace.logs.length < 12) {
      trace.logs.push(String(payload.params.entry.text || '').slice(0, 300))
    }
    if (m === 'Runtime.consoleAPICalled' && payload.params.type === 'error' && trace.console.length < 12) {
      trace.console.push(payload.params.args.map((a) => String(a.value === undefined ? a.description : a.value)).join(' ').slice(0, 300))
    }
  })
  await send('Page.enable')
  await send('Page.reload', { ignoreCache: false })
}
// --clear=dsh.sessions.current,dsh.workspace.view.* ：删掉这些 localStorage 键（* 结尾=前缀）后重载
if (args.has('clear')) {
  const patterns = String(args.get('clear')).split(',').map((s) => s.trim()).filter(Boolean)
  const removed = await evaluate(`(() => {
    const patterns = ${JSON.stringify(patterns)};
    const gone = [];
    for (const key of Object.keys(localStorage)) {
      if (patterns.some((p) => (p.endsWith('*') ? key.startsWith(p.slice(0, -1)) : key === p))) {
        localStorage.removeItem(key);
        gone.push(key);
      }
    }
    return gone;
  })()`)
  console.log('已清除 localStorage：' + JSON.stringify(removed))
  await send('Page.enable')
  await send('Page.reload', { ignoreCache: false })
}
// --set=key=js值 ：写入 localStorage（值是 JS 字面量，例如 --set="dsh.sessions.current=JSON.stringify('session-x')"）
// 多个用 ;; 分隔
if (args.has('set')) {
  for (const pair of String(args.get('set')).split(';;')) {
    const at = pair.indexOf('=')
    if (at < 0) continue
    const key = pair.slice(0, at)
    const expr = pair.slice(at + 1)
    const done = await evaluate(`(() => { localStorage.setItem(${JSON.stringify(key)}, String(${expr})); return localStorage.getItem(${JSON.stringify(key)}); })()`)
    console.log(`已写入 ${key} = ${String(done).slice(0, 160)}`)
  }
  await send('Page.enable')
  await send('Page.reload', { ignoreCache: false })
}
await sleep(waitMs)

if (args.has('entries')) {
  const needle = String(args.get('entries'))
  const list = await evaluate(`(() => performance.getEntriesByType('resource')
    .filter((e) => e.name.includes(${JSON.stringify(needle)}))
    .map((e) => ({ url: e.name.replace(/^https?:\\/\\/[^/]+/, ''), transferSize: e.transferSize, decoded: e.decodedBodySize, duration: Math.round(e.duration) })))()`)
  console.log('资源：' + JSON.stringify(list, null, 2))
}

if (args.has('roottext')) {
  const text = await evaluate(`(() => {
    const root = document.getElementById('root');
    return root ? String(root.textContent || '').slice(0, 800) : '(no #root)';
  })()`)
  console.log('root.textContent：' + text)
}

if (args.has('style')) {
  const info = await evaluate(`(() => {
    const rect = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
    const cs = (el) => { const s = getComputedStyle(el); return { display: s.display, visibility: s.visibility, opacity: s.opacity, overflow: s.overflow, height: s.height }; };
    const root = document.getElementById('root');
    const first = root && root.firstElementChild;
    return {
      styleSheetCount: document.styleSheets.length,
      sheetHrefs: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((l) => l.href.replace(/^https?:\\/\\/[^/]+/, '')).slice(0, 6),
      sheetRules: Array.from(document.styleSheets).map((s) => { try { return s.cssRules.length } catch { return 'blocked' } }),
      htmlRect: rect(document.documentElement), bodyRect: rect(document.body),
      rootRect: root ? rect(root) : null, firstRect: first ? rect(first) : null,
      bodyStyle: cs(document.body), rootStyle: root ? cs(root) : null, firstStyle: first ? cs(first) : null,
      firstCls: first ? String(first.className).slice(0, 80) : null,
      sidebarNodes: document.querySelectorAll('[class*="wtg9ga_"], [class*="GAkraW_"], [class*="GRgSLq_"]').length,
      bodyAttrs: document.documentElement.getAttributeNames(),
    };
  })()`)
  console.log('样式诊断：' + JSON.stringify(info, null, 2))
}

if (args.has('rootcss')) {
  const ruleHits = await evaluate(`(() => {
    const root = document.getElementById('root');
    if (!root) return '(no #root)';
    const hits = [];
    const scan = (rules, origin) => {
      for (const rule of rules) {
        if (rule.cssRules && rule.cssRules.length) { scan(rule.cssRules, origin + ' > ' + (rule.conditionText || rule.name || 'nested')); continue }
        if (!rule.selectorText) continue;
        let matches = false;
        try { matches = root.matches(rule.selectorText) } catch { matches = false }
        if (!matches) continue;
        const style = rule.style;
        const interesting = [];
        for (const prop of ['display', 'visibility', 'opacity', 'height']) {
          const value = style.getPropertyValue(prop);
          if (value) interesting.push(prop + ':' + value);
        }
        if (interesting.length) hits.push({ origin, matchedParts: rule.selectorText.split(',').map((s) => s.trim()).filter((s) => { try { return root.matches(s) } catch { return false } }), decl: interesting.join(';') });
      }
    };
    for (const sheet of document.styleSheets) {
      let rules = null;
      try { rules = sheet.cssRules } catch { continue }
      if (!rules) continue;
      scan(rules, (sheet.href || 'inline').replace(/^https?:\\/\\/[^/]+/, ''));
    }
    return hits;
  })()`)
  console.log('命中 #root 的样式规则：' + JSON.stringify(ruleHits, null, 2))
}

if (args.has('exprFile')) {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(String(args.get('exprFile')), 'utf8')
  const value = await evaluate(source)
  console.log('expr => ' + JSON.stringify(value, null, 2).slice(0, 6000))
}
if (args.has('expr')) {
  const value = await evaluate(String(args.get('expr')))
  console.log('expr => ' + JSON.stringify(value, null, 2).slice(0, 4000))
}

if (args.has('type')) {
  // 真键盘输入：先聚焦输入框，再用 CDP 打字 + 回车（合成事件唤不醒 React 的草稿状态）
  const focused = await evaluate(`(() => { const el = document.querySelector('[contenteditable="true"]'); if (!el) return false; el.focus(); return true })()`)
  if (focused) {
    // Lexical 编辑器：必须逐字输入（char 事件），insertText 只会改 DOM 不动编辑器状态
    for (const ch of String(args.get('type'))) {
      await send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch })
      await sleep(30)
    }
    await sleep(600)
    const typedText = await evaluate(`(() => { const el = document.querySelector('[contenteditable="true"]'); return String((el && el.textContent) || '').slice(0, 40) })()`)
    console.log('editorText => ' + typedText)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: String.fromCharCode(13), unmodifiedText: String.fromCharCode(13), windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await sleep(500)
    // 打完字 React 的草稿状态就有了，直接点发送按钮最稳
    const clicked = await evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('button')).filter((b) => /发送|send/i.test(String(b.getAttribute('aria-label') || b.textContent || '')));
      const target = buttons[buttons.length - 1];
      if (!target) return 'no-button';
      if (target.disabled) return 'disabled';
      target.click();
      return 'clicked';
    })()`)
    console.log('sendButton => ' + clicked)
    await sleep(Number(args.get('typeWait') || 6000))
  }
  const chips = await evaluate(`(() => Array.from(document.querySelectorAll('.dsh-room-author')).map((el) => String(el.textContent || '').trim()))()`)
  console.log('typed => focused=' + focused + ' chips=' + JSON.stringify(chips))
}
if (args.has('html')) {
  const selector = String(args.get('html'))
  const html = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.outerHTML.slice(0, 4000) : '(not found)' })()`)
  console.log('html ' + selector + ' => ' + html)
}
if (args.has('dump')) {
  const dump = await evaluate(`(() => {
    const out = {};
    for (const key of Object.keys(localStorage)) out[key] = String(localStorage.getItem(key)).slice(0, 200);
    return out;
  })()`)
  console.log('localStorage 内容：' + JSON.stringify(dump, null, 2))
}

const report = await evaluate(`(() => {
  const scripts = Array.from(document.querySelectorAll('script[src]')).map((s) => s.src);
  const bad = [];
  for (const entry of performance.getEntriesByType('resource')) {
    const status = entry.responseStatus;
    if (typeof status === 'number' && status >= 400) bad.push({ url: entry.name.slice(-120), status });
    else if (entry.transferSize === 0 && entry.decodedBodySize === 0 && /\\/plugins\\/|\\.js/.test(entry.name)) {
      bad.push({ url: entry.name.slice(-120), status: status === undefined ? 'no-status' : status, note: 'empty body' });
    }
  }
  return {
    href: location.href,
    title: document.title,
    bodyText: String(document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
    bodyHtmlLength: document.body.innerHTML.length,
    rootHtmlLength: (document.getElementById('root') || {}).innerHTML ? document.getElementById('root').innerHTML.length : null,
    scriptCount: scripts.length,
    scripts: scripts.map((s) => s.replace(/^https?:\\/\\/[^/]+/, '').slice(0, 160)),
    localStorageKeys: Object.keys(localStorage),
    sessionStorageKeys: Object.keys(sessionStorage),
    cookieNames: document.cookie.split(';').map((c) => c.trim().split('=')[0]).filter(Boolean),
    badResources: bad.slice(0, 12),
    outline: (() => {
      const root = document.getElementById('root') || document.body;
      const line = (el, depth) => ({
        d: depth,
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').split(' ')[0].slice(0, 40),
        w: Math.round(el.getBoundingClientRect().width),
        h: Math.round(el.getBoundingClientRect().height),
        text: String(el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30),
      });
      const rows = [];
      const walk = (el, depth) => {
        if (rows.length > 26 || depth > 2) return;
        rows.push(line(el, depth));
        for (const child of el.children) walk(child, depth + 1);
      };
      walk(root, 0);
      return rows;
    })(),
  };
})()`)

if (args.has('trace')) report.trace = trace
console.log(JSON.stringify(report, null, 2))

try { socket.close() } catch { /* 忽略 */ }
try { child.kill() } catch { /* 忽略 */ }
if (!keep && !args.has('profile')) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 忽略 */ } }
