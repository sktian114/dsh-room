/**
 * dsh-room 浏览器侧冒烟测试（不依赖真实浏览器）
 *
 *   node test/client.test.mjs
 *
 * 用最小 DOM / React 桩执行手写的 ModuleLoader bundle，验证：
 *   · bundle 能被 __ModuleLoader__.load 接收
 *   · apply 会注册 conversation.input.right 插槽
 *   · 按钮与面板的初始渲染不抛异常
 */
import { strict as assert } from 'node:assert'

const styles = new Map()
globalThis.document = {
  getElementById(id) { return styles.get(id) || null },
  createElement() { return { id: '', textContent: '' } },
  head: {
    appendChild(element) { if (element && element.id) styles.set(element.id, element) },
  },
  body: { appendChild() {}, removeChild() {} },
}
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })
const storage = {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
  setItem(key, value) { this.store.set(key, String(value)) },
  removeItem(key) { this.store.delete(key) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

let factory = null
globalThis.window = {
  localStorage: globalThis.localStorage,
  __ModuleLoader__: {
    load(spec) {
      assert.equal(spec.id, 'dsh-room')
      factory = spec.factory
    },
  },
}

await import('../lib/client.js')
assert.equal(typeof factory, 'function', 'bundle registered a factory')

function createElement(type, props) {
  const children = Array.prototype.slice.call(arguments, 2)
  return { type, props: props || {}, children }
}
const React = {
  createElement,
  Fragment: 'Fragment',
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, function () {}] },
  useEffect() {},
  useRef() { return { current: null } },
}
const moduleExports = factory(function (name) {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})

assert.equal(typeof moduleExports.apply, 'function')
assert.deepEqual(moduleExports.inject, ['slots'])

let registered = null
const ctx = {
  slots: {
    inject(name, callback) {
      assert.equal(name, 'conversation.input.right')
      registered = callback()
      return function () {}
    },
    register(spec, component) {
      return { spec, component }
    },
  },
}

moduleExports.apply(ctx)
assert.ok(registered, 'slot registration returned')
assert.equal(registered.spec.id, 'dsh-room')
assert.equal(registered.spec.order, 45)
assert.equal(registered.spec.name, 'conversation.input.right')
assert.equal(typeof registered.component, 'function')

const tree = registered.component()
assert.equal(tree.type, 'Fragment')
assert.ok(Array.isArray(tree.children))
assert.equal(tree.children.length, 2)
assert.equal(tree.children[0].type, 'button')
assert.equal(tree.children[0].children[1], '联机')

/* ── 用假 hooks 渲染各个视图，抓运行时错误 ── */

const view = moduleExports.__test
assert.ok(view, '__test exported')

function texts(node, out) {
  const bucket = out || []
  if (node === null || node === undefined || node === false) return bucket
  if (Array.isArray(node)) { node.forEach((child) => texts(child, bucket)); return bucket }
  if (typeof node === 'string' || typeof node === 'number') { bucket.push(String(node)); return bucket }
  if (typeof node.type === 'function') { texts(node.type(node.props || {}), bucket); return bucket }
  if (node.children) texts(node.children, bucket)
  return bucket
}

const members = [
  { id: 'host', name: '老王', kind: 'host' },
  { id: 'm1', name: '阿伟', kind: 'guest' },
]
const entries = [
  { name: 'src', type: 'dir', path: 'src' },
  { name: 'README.md', type: 'file', path: 'README.md' },
]

const hostViewTexts = texts(view.HostView({
  host: {
    running: true,
    room: { name: '老王的开发间', port: 8787, needsCode: true, code: '1234', workspace: 'E:\\proj' },
    urls: [{ url: 'http://172.16.1.130:8787', ip: '172.16.1.130', label: '蒲公英' }],
    members,
    hostToken: 'abc',
    policy: { defaultMode: 'blocked', entries: [] },
    workspaces: [{ id: 'w1', title: 'proj', path: 'E:\\proj', mode: 'readonly' }],
    workspace: { available: true, mode: 'readonly', root: 'E:\\proj', entries },
  },
  error: '',
  onRefresh() {},
}))
for (const expected of ['老王的开发间', '口令 1234', 'http://172.16.1.130:8787', '房间成员', '老王', '阿伟', '房主工作区', '共享权限', 'src', 'README.md', '停止房间']) {
  assert.ok(hostViewTexts.includes(expected), 'host view missing: ' + expected)
}

const guestViewTexts = texts(view.GuestView({
  guest: { addr: 'http://172.16.1.130:8787', token: 'token-1', name: '阿伟' },
  state: { ok: true, room: { name: '老王的开发间' }, members, workspaces: [{ id: 'w1', title: '开发间', mode: 'readonly' }], workspace: { available: true, mode: 'readonly', root: 'E:\\proj', entries } },
  onJoin() {},
  onState() {},
}))
for (const expected of ['已连接', '进入房主工作台', '房间成员', '阿伟', 'README.md', '离开房间']) {
  assert.ok(guestViewTexts.includes(expected), 'guest view missing: ' + expected)
}

// 工作区默认封锁：房客面板里不能出现工作区名字/路径，只显示「还没开放」
const guestBlockedTexts = texts(view.GuestView({
  guest: { addr: 'http://172.16.1.130:8787', token: 'token-1', name: '阿伟' },
  state: { ok: true, room: { name: '老王的开发间', workspace: '', workspaceMode: 'blocked' }, members, workspaces: [], workspace: { available: false, mode: 'blocked', name: '', entries: [] } },
  onJoin() {},
  onState() {},
}))
assert.ok(guestBlockedTexts.includes('房主还没有开放任何工作区。'), 'guest should see closed state')
assert.equal(guestBlockedTexts.some((text) => text.includes('E:\\proj')), false, 'blocked workspace path must not leak to guest')
assert.equal(guestBlockedTexts.some((text) => text.includes('README.md')), false, 'blocked workspace entries must not leak to guest')

// 只读工作区：房客看到「只读」徽标
const guestReadonlyTexts = texts(view.GuestView({
  guest: { addr: 'http://172.16.1.130:8787', token: 'token-1', name: '阿伟' },
  state: { ok: true, room: { name: '老王的开发间', workspaceMode: 'readonly' }, members, workspaces: [{ id: 'w1', title: '开发间', mode: 'readonly' }], workspace: { available: true, mode: 'readonly', root: 'E:\\proj', entries } },
  onJoin() {},
  onState() {},
}))
assert.ok(guestReadonlyTexts.includes('只读'), 'readonly badge missing')

const joinTree = view.GuestView({ guest: null, state: null, onJoin() {}, onState() {} })
const joinFormTexts = texts(joinTree)
for (const expected of ['房主地址', '加入房间']) {
  assert.ok(joinFormTexts.includes(expected), 'join form missing: ' + expected)
}
function placeholders(node, out) {
  const bucket = out || []
  if (!node || typeof node !== 'object') return bucket
  if (Array.isArray(node)) { node.forEach((child) => placeholders(child, bucket)); return bucket }
  if (typeof node.type === 'function') { placeholders(node.type(node.props || {}), bucket); return bucket }
  if (node.props && typeof node.props.placeholder === 'string') bucket.push(node.props.placeholder)
  if (node.children) placeholders(node.children, bucket)
  return bucket
}
assert.ok(placeholders(joinTree).includes('172.16.1.130:8787'), 'join placeholder missing')

const panelTexts = texts(moduleExports.__test.Panel({ onClose() {} }))
for (const expected of ['房间联机', '房主', '访客']) {
  assert.ok(panelTexts.includes(expected), 'panel missing: ' + expected)
}

// 心跳保活：guestState 由父组件持有，面板直接渲染成员（手机切后台回来不该是 0 人）
const guestPanelTexts = texts(moduleExports.__test.Panel({
  guest: { addr: 'http://172.16.1.130:8787', token: 'token-1', name: '阿伟' },
  guestState: { ok: true, room: { name: '老王的开发间' }, members, workspaces: [{ id: 'w1', title: '开发间', mode: 'readonly' }], workspace: { available: true, mode: 'readonly', root: 'E:\\proj', entries } },
  onClose() {},
}))
for (const expected of ['老王的开发间', '房间成员', '阿伟']) {
  assert.ok(guestPanelTexts.includes(expected), 'guest panel missing: ' + expected)
}

// 掉线自动重入失败（令牌失效 / 房间要口令）时，加入表单要显示原因
const rejoinFailTexts = texts(view.GuestView({
  guest: null,
  state: null,
  suggestedAddr: 'http://172.16.1.130:8787',
  initialError: '登录已失效，请重新加入',
  onJoin() {},
  onState() {},
}))
assert.ok(rejoinFailTexts.includes('登录已失效，请重新加入'), 'join form should show stale reason')

assert.equal(view.normalizeAddr('172.16.1.130'), 'http://172.16.1.130:8787')
assert.equal(view.normalizeAddr('172.16.1.130:9000/'), 'http://172.16.1.130:9000')
assert.equal(view.normalizeAddr('https://room.example.com'), 'https://room.example.com:8787')

/* ── 手机链路上新增的两条逻辑 ── */

// 非安全上下文（http://IP）没有 navigator.clipboard，execCommand 也会失败；
// copyText 必须如实返回 false，交给上层弹「长按复制」兜底，而不是假装成功。
const copied = await view.copyText('http://172.16.1.130:8787')
assert.equal(copied, false, 'insecure copy should report failure, not success')

// 没有 window.location 的环境（如测试桩）里，currentOrigin 不能抛异常
assert.equal(view.currentOrigin(), '')

// 访客从房主地址打开时，加入表单的地址应预填成当前房间地址
const seededTree = view.GuestView({
  guest: null, state: null, suggestedAddr: 'http://172.16.1.130:8787', onJoin() {}, onState() {},
})
function findByClass(node, className, out) {
  const bucket = out || []
  if (!node || typeof node !== 'object') return bucket
  if (Array.isArray(node)) { node.forEach((child) => findByClass(child, className, bucket)); return bucket }
  if (typeof node.type === 'function') { findByClass(node.type(node.props || {}), className, bucket); return bucket }
  if (node.props && String(node.props.className || '').split(' ').includes(className)) bucket.push(node)
  if (node.children) findByClass(node.children, className, bucket)
  return bucket
}
const joinInputs = findByClass(seededTree, 'dsh-room-join-input')
assert.equal(joinInputs.length, 1, 'join input rendered')
assert.equal(joinInputs[0].props.value, 'http://172.16.1.130:8787', 'join input prefilled from suggestedAddr')
assert.equal(joinInputs[0].props.inputMode, 'url', 'join input should use url keyboard')
assert.equal(joinInputs[0].props.enterKeyHint, 'go')

console.log('dsh-room client smoke test: PASS')
