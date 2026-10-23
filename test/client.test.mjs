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
// 关闭状态：只有「联机」按钮，房间面板与聊天面板都不渲染
assert.equal(tree.children.filter(Boolean).length, 1)
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

const panelTree = moduleExports.__test.Panel({ onClose() {}, onChat() {} })
const panelTexts = texts(panelTree)
for (const expected of ['房间联机', '房主', '访客']) {
  assert.ok(panelTexts.includes(expected), 'panel missing: ' + expected)
}
// 聊天改为右上角独立入口（不是第三个标签）
assert.ok(JSON.stringify(panelTree).includes('打开房间聊天'), 'panel should expose the chat entry')

// 聊天面板：房间未开启时给一句提示，而不是空白
const chatOffTree = moduleExports.__test.ChatPanel({ base: '', token: '', isHost: false, roomOn: false })
const chatOffTexts = texts(chatOffTree)
assert.ok(chatOffTexts.some((text) => text.includes('开房或加入房间')), 'chat panel should hint when room is off')
assert.ok(chatOffTexts.some((text) => text.includes('房间聊天')), 'chat panel should title itself')

// 房主在聊天面板里能看到「新建群」和 agent 入口；房客看不到
const hostChatTexts = texts(moduleExports.__test.ChatPanel({
  base: '', token: '', isHost: true, roomOn: true, roomName: '老王的开发间',
}))
assert.ok(hostChatTexts.includes('新建群'), 'host chat panel should offer group creation')
assert.ok(hostChatTexts.includes('agent'), 'host chat panel should expose the agent picker')
assert.ok(hostChatTexts.some((text) => text.includes('这里还很安静')), 'host chat panel should show the empty state')
const guestChatTree = moduleExports.__test.ChatPanel({ base: '', token: '', isHost: false, roomOn: true })
assert.ok(!JSON.stringify(guestChatTree).includes('新建群'), 'guest chat panel must not offer group creation')

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

/* ── 自定义下拉 / 选择文件夹 / 拖动面板 ── */

function findTag(node, tag, out) {
  const bucket = out || []
  if (!node || typeof node !== 'object') return bucket
  if (Array.isArray(node)) { node.forEach((child) => findTag(child, tag, bucket)); return bucket }
  if (typeof node.type === 'function') { findTag(node.type(node.props || {}), tag, bucket); return bucket }
  if (node.type === tag) bucket.push(node)
  if (node.children) findTag(node.children, tag, bucket)
  return bucket
}

// 1. 单选下拉：显示当前项的文案，且不再产生原生 <select>
const selectTree = view.Select({
  value: 'write',
  onChange() {},
  options: [
    { value: 'blocked', label: '未开放' },
    { value: 'readonly', label: '只读' },
    { value: 'write', label: '仅工作区可写' },
    { value: 'full', label: '完全权限' },
  ],
})
const selectTexts = texts(selectTree)
assert.ok(selectTexts.includes('仅工作区可写'), 'select should show the current label')
assert.equal(findTag(selectTree, 'select').length, 0, 'no native <select> inside the custom dropdown')
assert.equal(findByClass(selectTree, 'dsh-room-sel-trigger').length, 1, 'select trigger rendered')
assert.equal(findByClass(selectTree, 'dsh-room-sel-pop').length, 0, 'menu stays closed until opened')
const trigger = findByClass(selectTree, 'dsh-room-sel-trigger')[0]
assert.equal(trigger.props['aria-haspopup'], 'listbox')
assert.equal(trigger.props['aria-expanded'], 'false')
// 值不在选项里时（手工填过的路径）直接显示原值，不要显示成空
const rawSelectTexts = texts(view.Select({ value: 'E:\\proj', options: [], onChange() {} }))
assert.ok(rawSelectTexts.includes('E:\\proj'), 'select should fall back to the raw value')

// 2. 房主表单：有原生选择框能力时用「选择文件夹…」，没有就退回手输路径
const hostFormHost = {
  running: false,
  room: null,
  urls: [],
  members: [],
  policy: { defaultMode: 'blocked', entries: [] },
  workspaces: [{ id: 'w1', title: 'proj', path: 'E:\\proj', mode: 'readonly' }],
  workspace: null,
  defaultWorkspace: 'E:\\proj',
}
const hostWithPicker = view.HostView({
  host: hostFormHost,
  error: '',
  pickFolder: () => Promise.resolve('D:\\data'),
  onRefresh() {},
  notify() {},
})
const pickerTexts = texts(hostWithPicker)
assert.ok(pickerTexts.some((text) => text.includes('选择文件夹')), 'host form should offer the folder picker')
assert.equal(findByClass(hostWithPicker, 'dsh-room-pickrow').length >= 1, true, 'picker row rendered')
assert.equal(
  pickerTexts.some((text) => text.includes('绝对路径')),
  false,
  'path typing placeholder should be gone when a picker is available',
)
const hostNoPicker = view.HostView({ host: hostFormHost, error: '', onRefresh() {}, notify() {} })
assert.ok(
  placeholders(hostNoPicker).some((text) => text.includes('绝对路径')),
  'without a picker the manual path input must stay as fallback',
)

// 房间已开：共享权限里的「单独开放某个文件夹」也必须是选择框，而不是手输路径
const hostRunningPicker = view.HostView({
  host: {
    running: true,
    room: { name: '老王的开发间', port: 8787, needsCode: false, code: '', workspace: 'E:\\proj' },
    urls: [{ url: 'http://172.16.1.130:8787', ip: '172.16.1.130', label: '蒲公英' }],
    members,
    hostToken: 'abc',
    policy: { defaultMode: 'blocked', entries: [] },
    workspaces: [{ id: 'w1', title: 'proj', path: 'E:\\proj', mode: 'readonly' }],
    workspace: { available: true, mode: 'readonly', root: 'E:\\proj', entries },
  },
  error: '',
  pickFolder: () => Promise.resolve('D:\\data'),
  onRefresh() {},
  notify() {},
})
const runningPickerTexts = texts(hostRunningPicker)
assert.ok(
  runningPickerTexts.some((text) => text.includes('选择要单独开放的文件夹')),
  'running host should offer the folder picker for extra folders',
)
assert.equal(findByClass(hostRunningPicker, 'dsh-room-pickpath').length >= 1, true, 'picked-folder box rendered')
assert.equal(
  placeholders(hostRunningPicker).some((text) => text.includes('绝对路径')),
  false,
  'running host must not ask for a typed folder path',
)

// 3. 选择目录能力：优先 Electron 原生桥，其次 DSH 工作区服务，都没有就返回 null
globalThis.__DSH_DIRECTORY_PICKER__ = { pick: async () => 'D:\\picked' }
const bridgePicker = view.resolvePickFolder({})
assert.equal(typeof bridgePicker, 'function', 'native bridge should be used when present')
assert.equal(await bridgePicker(), 'D:\\picked')
delete globalThis.__DSH_DIRECTORY_PICKER__
assert.equal(view.resolvePickFolder({}), null, 'no bridge and no workspace service means no picker')
const workspacePicker = view.resolvePickFolder({ uiWorkspace: { pickDirectory: async () => 'E:\\ws' } })
assert.equal(await workspacePicker('选工作区'), 'E:\\ws', 'workspace service should be the fallback')

// 4. 拖动：房间面板与聊天面板的头部都挂了指针事件
const dragPanelTree = view.Panel({
  guest: { addr: 'http://172.16.1.130:8787', token: 'token-1', name: '阿伟' },
  guestState: { ok: true, room: { name: '老王的开发间' }, members, workspaces: [], workspace: null },
  onClose() {},
})
const roomHeads = findByClass(dragPanelTree, 'dsh-room-head')
assert.equal(roomHeads.length, 1, 'room panel header rendered once')
assert.equal(typeof roomHeads[0].props.onPointerDown, 'function', 'room panel header must start a drag')
assert.equal(typeof roomHeads[0].props.onPointerMove, 'function', 'room panel header must track the drag')
assert.equal(typeof roomHeads[0].props.onPointerUp, 'function', 'room panel header must finish the drag')
const dragChatTree = view.ChatPanel({ base: '', token: '', isHost: true, roomOn: true })
for (const cls of ['dsh-room-chathead', 'dsh-room-chatlist-head']) {
  const heads = findByClass(dragChatTree, cls)
  assert.equal(heads.length >= 1, true, cls + ' rendered')
  assert.equal(typeof heads[0].props.onPointerDown, 'function', cls + ' must start a drag')
}
assert.equal(
  findByClass(dragChatTree, 'dsh-room-chatpanel')[0].props['data-dragging'],
  'false',
  'chat panel exposes its dragging state',
)

console.log('dsh-room client smoke test: PASS')
