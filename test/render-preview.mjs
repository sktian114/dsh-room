/**
 * 用真实 client.js + 假 React 把各个视图渲染成静态 HTML，供真浏览器截图检查外观。
 * 不是测试，是视觉验收工具：
 *   node test/render-preview.mjs
 * 产出 preview/rendered.html
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/* ── 假 DOM：捕获 ensureStyle 注入的 CSS ── */
const styleNodes = new Map()
globalThis.document = {
  getElementById(id) { return styleNodes.get(id) || null },
  createElement() { return { id: '', textContent: '' } },
  head: { appendChild(el) { if (el && el.id) styleNodes.set(el.id, el) } },
  body: { appendChild() {}, removeChild() {} },
  addEventListener() {},
  removeEventListener() {},
}
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })
const storage = {
  store: new Map(),
  getItem(k) { return this.store.has(k) ? this.store.get(k) : null },
  setItem(k, v) { this.store.set(k, String(v)) },
  removeItem(k) { this.store.delete(k) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
globalThis.window = {
  localStorage: storage,
  innerWidth: 1280,
  innerHeight: 900,
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: { load(spec) { captured = spec } },
}

let captured = null
await import('../lib/client.js')

function createElement(type, props) {
  const children = Array.prototype.slice.call(arguments, 2)
  return { type, props: props || {}, children }
}
const React = {
  createElement,
  Fragment: 'Fragment',
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useEffect() {},
  useRef() { return { current: null } },
}
const moduleExports = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require ' + name)
})

let registered = null
moduleExports.apply({
  slots: {
    inject(_name, cb) { registered = cb(); return () => {} },
    register(spec, component) { return { spec, component } },
  },
})

const css = styleNodes.get('dsh-room-style') ? styleNodes.get('dsh-room-style').textContent : ''
if (!css) throw new Error('ensureStyle 没有注入 CSS')

/* ── 极简 SSR ── */
const VOID = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'use', 'stop', 'ellipse'])
function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function kebab(key) {
  return key.replace(/[A-Z]/g, (char) => '-' + char.toLowerCase())
}
function styleText(style) {
  return Object.keys(style || {}).map((key) => {
    const value = style[key]
    if (value === null || value === undefined || value === '') return ''
    return (key.startsWith('--') ? key : kebab(key)) + ':' + value
  }).filter(Boolean).join(';')
}
const SVG_CAMEL = {
  viewBox: 'viewBox',
  strokeWidth: 'stroke-width',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  strokeDasharray: 'stroke-dasharray',
  strokeDashoffset: 'stroke-dashoffset',
  fillRule: 'fill-rule',
  clipRule: 'clip-rule',
  stopColor: 'stop-color',
  stopOpacity: 'stop-opacity',
}
function attrsOf(element) {
  const props = element.props || {}
  const out = []
  for (const key of Object.keys(props)) {
    if (key === 'children' || key === 'ref' || key === 'key' || key.startsWith('on')) continue
    if (props[key] === null || props[key] === undefined || props[key] === false) continue
    let name = key === 'className' ? 'class' : key === 'htmlFor' ? 'for' : key
    if (SVG_CAMEL[name]) name = SVG_CAMEL[name]
    if (name === 'style') {
      const text = styleText(props.style)
      if (text) out.push('style="' + escapeHtml(text) + '"')
      continue
    }
    out.push(props[key] === true ? name : name + '="' + escapeHtml(props[key]) + '"')
  }
  return out.length ? ' ' + out.join(' ') : ''
}
function render(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (Array.isArray(node)) return node.map(render).join('')
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (typeof node.type === 'function') return render(node.type(Object.assign({}, node.props, { children: node.children.length === 1 ? node.children[0] : node.children })))
  if (node.type === 'Fragment') return node.children.map(render).join('')
  const tag = String(node.type)
  const inner = node.children.map(render).join('')
  if (VOID.has(tag)) return '<' + tag + attrsOf(node) + ' />'
  return '<' + tag + attrsOf(node) + '>' + inner + '</' + tag + '>'
}

/* ── 场景数据 ── */
const members = [
  { id: 'host', name: '老王', kind: 'host', joinedAt: Date.now() - 720000, lastSeen: Date.now() },
  { id: 'g1', name: '阿伟', kind: 'guest', joinedAt: Date.now() - 60000, lastSeen: Date.now() - 5000 },
  { id: 'g2', name: '小鹿', kind: 'guest', joinedAt: Date.now() - 180000, lastSeen: Date.now() - 130000 },
]
const entries = [
  { name: 'dsh-room', type: 'dir', path: 'dsh-room' },
  { name: 'index.mjs', type: 'file', path: 'index.mjs' },
  { name: '修仙文字游戏', type: 'dir', path: '修仙文字游戏' },
]
const runningHost = {
  running: true,
  room: { id: 'r1', name: '老王的开发间', port: 8787, code: '1234', needsCode: true, startedAt: Date.now() - 720000, workspace: 'E:\\E Download\\AIWorking\\dsh space' },
  urls: [
    { url: 'http://172.16.1.130:8787', label: '虚拟内网' },
    { url: 'http://192.168.1.5:8787', label: '局域网' },
  ],
  members,
  hostToken: 'host-token',
  workspace: { root: 'E:\\E Download\\AIWorking\\dsh space', name: 'dsh space', entries },
  workspaces: [{ id: 'w1', title: 'dsh space', path: 'E:\\E Download\\AIWorking\\dsh space' }],
  defaultWorkspace: 'E:\\E Download\\AIWorking\\dsh space',
  dshPort: 51194,
}
const stoppedHost = { running: false, room: null, urls: [], members: [], hostToken: '', workspaces: runningHost.workspaces, defaultWorkspace: runningHost.defaultWorkspace, workspace: null }
const guestState = { ok: true, room: { name: '老王的开发间', needsCode: true, workspace: 'dsh space' }, members, workspace: { root: 'E:\\E Download\\AIWorking\\dsh space', entries } }

const pickFolder = () => Promise.resolve('D:\\Backup\\共享资料')
const views = {
  hostRunning: render(React.createElement(moduleExports.__test.HostView, { host: runningHost, error: '', notify() {}, onRefresh() {}, pickFolder })),
  guestJoin: render(React.createElement(moduleExports.__test.GuestView, { guest: null, state: null, notify() {}, onJoin() {}, onState() {} })),
  hostForm: render(React.createElement(moduleExports.__test.HostView, { host: stoppedHost, error: '', notify() {}, onRefresh() {}, pickFolder })),
  hostFormNoPicker: render(React.createElement(moduleExports.__test.HostView, { host: stoppedHost, error: '', notify() {}, onRefresh() {} })),
  guestJoined: render(React.createElement(moduleExports.__test.GuestView, { guest: { addr: 'http://172.16.1.130:8787', token: 't', name: '阿伟' }, state: guestState, notify() {}, onJoin() {}, onState() {} })),
  // 下拉展开态：静态渲染拿不到交互，这里用同样的类名手写一份，只为核对视觉
  selectOpen: '<div class="dsh-room-sel" data-open="true" style="width:200px">'
    + '<button type="button" class="dsh-room-sel-trigger"><span class="dsh-room-sel-label">仅工作区可写</span>'
    + '<span class="dsh-room-sel-chev">' + icon('chevron', 13, 1.9) + '</span></button>'
    + '<div class="dsh-room-sel-pop" role="listbox" style="left:22px;top:392px;width:200px">'
    + [['未开放', false], ['只读', false], ['仅工作区可写', true], ['完全权限', false]].map(([label, selected]) =>
        '<div class="dsh-room-sel-opt" role="option" data-selected="' + selected + '" data-active="' + (label === '仅工作区可写') + '">'
        + '<span class="dsh-room-sel-tick">' + icon('check', 12, 2.4) + '</span>'
        + '<span class="dsh-room-sel-text">' + label + '</span></div>').join('')
    + '</div></div>',
}

/* ── 聊天面板场景（左列群列表 + 右列消息流）── */
const demoGroups = [
  { id: 'lobby', name: '大厅', agents: [] },
  { id: 'g-fe', name: '前端小组', agents: [{ id: 's1', title: '重构助手' }] },
  { id: 'g-lore', name: '世界观讨论', agents: [{ id: 's2', title: '设定审查' }, { id: 's3', title: '连续性检查' }] },
]
const demoMessages = [
  { seq: 1, at: Date.now() - 660000, group: 'lobby', from: { kind: 'system', id: 'room', name: '系统' }, text: '阿伟 加入了房间' },
  { seq: 2, at: Date.now() - 600000, group: 'lobby', from: { kind: 'host', id: 'host', name: '老王' }, text: '人都到齐了吗？' },
  { seq: 3, at: Date.now() - 540000, group: 'lobby', from: { kind: 'user', id: 'g1', name: '阿伟' }, text: '到了，工作台刚打开。' },
  { seq: 4, at: Date.now() - 480000, group: 'lobby', from: { kind: 'user', id: 'g3', name: '阿伟' }, text: '我是另一个阿伟（手机端），头像颜色跟我俩不一样吧？' },
  { seq: 5, at: Date.now() - 420000, group: 'lobby', from: { kind: 'agent', id: 's1', name: '重构助手' }, text: '我把聊天视图拆成了右侧独立面板：左边是群列表，右边是消息流。' },
  { seq: 6, at: Date.now() - 300000, group: 'g-fe', from: { kind: 'user', id: 'g2', name: '小鹿' }, text: '这个气泡和 DSH 的主题挺搭。' },
  { seq: 7, at: Date.now() - 120000, group: 'g-lore', from: { kind: 'agent', id: 's2', name: '设定审查' }, text: '名册里「青芜界」的三个势力都对上了，没有矛盾。' },
]
const chatSeed = { groups: demoGroups, messages: demoMessages, self: 'g1', active: 'lobby' }
const viewsChat = {
  host: render(React.createElement(moduleExports.__test.ChatPanel, {
    base: '', token: '', isHost: true, roomOn: true, roomName: '老王的开发间', initial: chatSeed,
  })),
  guest: render(React.createElement(moduleExports.__test.ChatPanel, {
    base: '', token: '', isHost: false, roomOn: true, roomName: '老王的开发间', initial: Object.assign({}, chatSeed, { self: 'g2' }),
  })),
}
const launch = render(React.createElement(registered.component, {}))

function icon(name, size, stroke) {
  return render(React.createElement(moduleExports.__test.Icon, { name, size, stroke }))
}
function shell(inner, tab) {
  return '<div class="dsh-room-panel preview-panel">'
    + '<div class="dsh-room-head"><div class="dsh-room-heading">'
    + '<div class="dsh-room-title">房间联机</div>'
    + '<div class="dsh-room-sub">同一网络内共享同一个 DSH 工作区</div></div>'
    + '<button class="dsh-room-iconbtn" aria-label="关闭">' + icon('x', 14, 1.8) + '</button></div>'
    + '<div class="dsh-room-tabs" role="tablist" style="--tab-index:' + (tab === 'host' ? 0 : 1) + '">'
    + '<span class="dsh-room-tab-indicator" aria-hidden="true"></span>'
    + '<button class="dsh-room-tab" data-active="' + (tab === 'host') + '">房主</button>'
    + '<button class="dsh-room-tab" data-active="' + (tab === 'guest') + '">访客</button></div>'
    + inner + '</div>'
}

/* ── 预览页 ── */
const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-room 渲染预览</title>
<style>
:root{
  --dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-2:#f6f7f9;--dsw-alias-bg-overlay:#fff;
  --dsw-alias-label-primary:#0f1115;--dsw-alias-label-secondary:#5b6270;--dsw-alias-label-tertiary:#8a919e;
  --dsw-alias-border-l2:rgba(0,0,0,.09);--dsw-alias-border-l3:rgba(0,0,0,.13);
  --dsw-alias-interactive-bg-hover:rgba(15,17,21,.05);--dsw-alias-interactive-bg-active:rgba(15,17,21,.085);
  --dsw-alias-state-business-primary:#4176e6;--dsw-alias-state-success-primary:#1fa855;
  --dsw-alias-state-error-primary:#d92d20;--dsw-alias-state-warn-primary:#f59e0b;
  --dsw-alias-brand-primary:#101114;--dsw-alias-label-primary-foreground:#fff;
  --dsw-elevation-prominent:0 0 0 .5px rgba(0,0,0,.12),0 16px 40px rgba(0,0,0,.14),0 2px 8px rgba(0,0,0,.05);
  --dsw-focus-ring-color:rgba(65,118,230,.55);
  --dsw-font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  --dsw-font-family-code:ui-monospace,Consolas,monospace;
  --dsw-radius-lg:16px;--dsw-radius-md:12px;
}
.theme-dark{
  --dsw-alias-bg-base:#1a1b1e;--dsw-alias-bg-layer-2:#111214;--dsw-alias-bg-overlay:#202125;
  --dsw-alias-label-primary:#f2f3f5;--dsw-alias-label-secondary:#b6bbc4;--dsw-alias-label-tertiary:#8b919c;
  --dsw-alias-border-l2:rgba(255,255,255,.10);--dsw-alias-border-l3:rgba(255,255,255,.15);
  --dsw-alias-interactive-bg-hover:rgba(255,255,255,.07);--dsw-alias-interactive-bg-active:rgba(255,255,255,.11);
  --dsw-alias-brand-primary:#f2f3f5;--dsw-alias-label-primary-foreground:#17181b;
  --dsw-elevation-prominent:0 0 0 .5px rgba(255,255,255,.14),0 18px 48px rgba(0,0,0,.6);
}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:#eef0f3;font:13px/20px var(--dsw-font-family);color:#0f1115}
.theme-dark body{background:#0b0c0e}
h2{font:600 12px/18px var(--dsw-font-family);letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin:0 0 10px}
.grid{display:flex;flex-wrap:wrap;gap:22px;align-items:flex-start}
.slot{width:412px}
.viewport{background:var(--dsw-alias-bg-layer-2);border-radius:16px;padding:14px;display:flex;flex-direction:column;gap:10px;min-height:120px}
.viewport .dsh-room-panel{position:relative;right:auto;bottom:auto;width:100%;max-height:none}
.composer{display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:14px;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l3)}
.grow{flex:1;color:var(--dsw-alias-label-tertiary);font-size:13px}
/* 聊天面板在预览页里改成静态摆放（真实环境是 fixed 右侧浮层） */
.preview-chat{grid-column:1 / -1}
.preview-chat .dsh-room-chatpanel{position:relative!important;right:auto!important;top:auto!important;
  transform:none!important;width:760px!important;max-width:100%!important;height:452px!important;
  margin-bottom:22px;animation:none!important}
/* 手机尺寸：直接按媒体查询里的规则摆一个 390px 宽的框 */
.mobile-frame{width:390px;height:700px;border-radius:26px;overflow:hidden;position:relative;
  background:var(--dsw-alias-bg-layer-2);border:9px solid #15171a;box-shadow:0 18px 40px rgba(0,0,0,.25)}
.mobile-frame .dsh-room-chatpanel{position:absolute!important;inset:0!important;width:auto!important;
  height:100%!important;max-height:none!important;border-radius:0!important;transform:none!important;
  grid-template-columns:1fr!important;animation:none!important}
.mobile-frame .dsh-room-chatback{display:inline-flex!important}
.mobile-frame[data-view=list] .dsh-room-chatmain{display:none}
.mobile-frame[data-view=thread] .dsh-room-chatlist{display:none}
.mobile-frame .dsh-room-chatlog{padding:12px}
/* 下拉展开态：预览页里把浮层改成相对定位，好跟触发器一起入镜 */
.dropdown-stage{position:relative;min-height:236px;padding:10px;border-radius:12px;
  background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l3)}
.dropdown-stage .dsh-room-sel-pop{position:absolute!important;left:12px!important;top:46px!important;
  width:200px!important;max-height:none!important;animation:none!important}
${css}
</style></head><body>
<h2>dsh-room · 真实组件渲染（浅色）</h2>
<div class="grid">
  <div class="slot"><div class="viewport">${shell(views.hostRunning, 'host')}<div class="composer"><span class="grow">给 DeepSeek 发送消息</span>${launch}</div></div></div>
  <div class="slot"><div class="viewport">${shell(views.guestJoin, 'guest')}</div></div>
  <div class="slot"><div class="viewport">${shell(views.hostForm, 'host')}</div></div>
  <div class="slot"><div class="viewport">${shell(views.guestJoined, 'guest')}</div></div>
  <div class="slot"><div class="viewport"><div class="dropdown-stage">${views.selectOpen}</div></div></div>
</div>
<h2 style="margin-top:28px">dsh-room · 聊天面板（房主 / 访客）</h2>
<div class="preview-chat">${viewsChat.host}</div>
<div class="preview-chat">${viewsChat.guest}</div>
<h2 style="margin-top:8px">手机 · 列表 → 消息 两级</h2>
<div class="grid">
  <div class="mobile-frame" data-view="list">${viewsChat.host}</div>
  <div class="mobile-frame" data-view="thread">${viewsChat.host}</div>
</div>
<div class="theme-dark" data-ds-dark-theme="true" style="margin-top:28px;padding:20px;border-radius:16px;background:#0b0c0e">
<h2 style="color:#6b7280">dsh-room · 真实组件渲染（深色）</h2>
<div class="grid">
  <div class="slot"><div class="viewport">${shell(views.hostRunning, 'host')}<div class="composer"><span class="grow">给 DeepSeek 发送消息</span>${launch}</div></div></div>
  <div class="slot"><div class="viewport">${shell(views.guestJoined, 'guest')}</div></div>
  <div class="slot"><div class="viewport">${shell(views.guestJoin, 'guest')}</div></div>
</div>
<div class="preview-chat">${viewsChat.host}</div>
</div>
</body></html>`

mkdirSync(join(here, '..', 'preview'), { recursive: true })
writeFileSync(join(here, '..', 'preview', 'rendered.html'), page, 'utf8')
console.log('wrote preview/rendered.html', page.length, 'bytes')
