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
import { DENY_REASONS } from '../lib/deny.mjs'

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
const bundleRegistry = new Map()
globalThis.window = {
  localStorage: globalThis.localStorage,
  __ModuleLoader__: {
    load(spec) {
      assert.equal(bundleRegistry.has(spec.id), false, 'each id registers once')
      bundleRegistry.set(spec.id, spec.factory)
    },
  },
}

await import('../lib/client.js')
// 宿主启动清单里的条目 id 就是包名；注册成目录名会被判定「loaded without registering」并整页白屏。
assert.ok(bundleRegistry.has('@sktian114/dsh-room'), 'bundle registered under the package name')
assert.ok(bundleRegistry.has('dsh-room'), 'bundle kept the unscoped alias')
factory = bundleRegistry.get('@sktian114/dsh-room')
assert.equal(typeof factory, 'function', 'bundle registered a factory')
assert.deepEqual(
  bundleRegistry.get('dsh-room')((id) => ({ forwarded: id })),
  { forwarded: '@sktian114/dsh-room' },
  'alias factory forwards to the package module',
)

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

// 5. 消息里的「谁是谁」：系统提示单独一行、访客各自带身份标签和头像
const whoMessages = [
  { seq: 1, at: Date.now() - 60000, group: 'lobby', from: { kind: 'system', id: 'room', name: '系统' }, text: '阿伟 加入了房间' },
  { seq: 2, at: Date.now() - 50000, group: 'lobby', from: { kind: 'host', id: 'host', name: '老王' }, text: '欢迎' },
  { seq: 3, at: Date.now() - 40000, group: 'lobby', from: { kind: 'user', id: 'g1', name: '阿伟' }, text: '谢谢' },
  { seq: 4, at: Date.now() - 30000, group: 'lobby', from: { kind: 'user', id: 'g2', name: '访客6105' }, text: '我也在' },
  { seq: 5, at: Date.now() - 20000, group: 'lobby', from: { kind: 'user', id: 'g3', name: '访客8842' }, text: '我也是访客' },
]
const whoTree = view.ChatPanel({
  base: '', token: '', isHost: true, roomOn: true,
  initial: { groups: [{ id: 'lobby', name: '大厅', agents: [] }], messages: whoMessages, self: 'g1', active: 'lobby' },
})
const whoTexts = texts(whoTree)
assert.ok(whoTexts.some((text) => text.includes('阿伟 加入了房间')), 'system notice should be rendered')
assert.equal(findByClass(whoTree, 'dsh-room-sysmsg').length, 1, 'system notice gets its own row, not a bubble')
const roles = findByClass(whoTree, 'dsh-room-msgrole').map((node) => node.props['data-kind'])
assert.deepEqual([...roles].sort(), ['host', 'user', 'user', 'user'], 'each message carries a role tag')
// 昵称要显示出来（不是只靠头像），且带上身份 id 便于排查
const rows = findByClass(whoTree, 'dsh-room-msgrow')
assert.deepEqual(rows.map((row) => row.props['data-identity']), ['host', 'g1', 'g2', 'g3'])
assert.deepEqual(
  findByClass(whoTree, 'dsh-room-msgname').map((node) => node.children[0]),
  ['老王', '阿伟', '访客6105', '访客8842'],
  'each message shows the sender nickname',
)
// 头像：同名不同 id 不同色；默认名「访客6105」取尾号，避免所有人头像一样
const avatars = findByClass(whoTree, 'dsh-room-msgavatar')
assert.equal(avatars.length, 4, 'system notice has no avatar')
assert.notEqual(avatars[1].props.style['--item-hue'], avatars[2].props.style['--item-hue'], 'same-name guests must not share a colour')
assert.deepEqual(avatars.map((node) => node.children[0]), ['老王', '阿伟', '05', '42'])
assert.equal(avatars[2].props.title.includes('g2'), true, 'avatar tooltip carries the identity id')
assert.deepEqual(rows.map((row) => row.props['data-self']), ['false', 'true', 'false', 'false'], 'only my own message is right-aligned')
assert.equal(moduleExports.__test.initialsOf('访客6105'), '05')
assert.equal(moduleExports.__test.initialsOf('阿伟'), '阿伟')
assert.equal(moduleExports.__test.initialsOf('Ada Lovelace'), 'AL')

// 6. 房客撞墙提示：403 + room/* 的响应要能翻译成人话，且钩子不改变原响应
const denyTitles = moduleExports.__test.DENY_TITLES
assert.ok(denyTitles['room/readonly'].includes('没有发送权限'), 'readonly 有明确标题')
// 服务端每个拒绝 code 都要有对应标题，不能漏
for (const entry of Object.values(DENY_REASONS)) {
  assert.ok(denyTitles[entry.code], '客户端缺少 ' + entry.code + ' 的提示标题')
}
// 旧版宿主只有 error 枚举时也要能翻成人话
const legacyNotice = moduleExports.__test.denyNoticeFor({ ok: false, error: 'workspace-readonly' })
assert.equal(legacyNotice.code, 'room/readonly')
assert.ok(legacyNotice.title.includes('没有发送权限'))
assert.ok(legacyNotice.text.includes('只读权限'))
assert.equal(moduleExports.__test.denyNoticeFor({ ok: false, error: 'bad-code' }), null, '普通业务错误不弹权限提示')
assert.equal(moduleExports.__test.denyNoticeFor({ ok: true }), null)
globalThis.window.fetch = function () {
  return Promise.resolve({
    status: 403,
    clone() {
      return {
        text: () => Promise.resolve(JSON.stringify({
          ok: false,
          error: 'workspace-readonly',
          code: 'room/readonly',
          message: '当前是只读权限（房主设置），不能向 Agent 发送指令。',
        })),
      }
    },
  })
}
let calls = 0
const stubbed = globalThis.window.fetch
globalThis.window.fetch = function () { calls += 1; return stubbed.apply(this, arguments) }
assert.equal(moduleExports.__test.installDenyNotice(), true)
assert.equal(globalThis.window.__dshRoomDenyHook, true)
assert.equal(moduleExports.__test.installDenyNotice(), true)
const denied = await globalThis.window.fetch('/api/session/prompt', { method: 'POST' })
assert.equal(calls, 1)
assert.equal(denied.status, 403, 'hook is transparent: caller still sees the 403')
await new Promise((resolve) => setTimeout(resolve, 10))
assert.equal(calls, 1, 'installing twice must not double-wrap fetch')

// 7. 会话里的「谁发的」：user-text 规则把 〔@名字〕 切成节点，插槽画成头像 + 昵称
const authorRule = moduleExports.__test.authorRule
assert.equal(authorRule.id, moduleExports.__test.AUTHOR_NODE_ID)
const cut = authorRule.match('〔@访客6105〕\n帮我改标题', 0)
assert.deepEqual(cut, { id: 'room-author', start: 0, end: '〔@访客6105〕'.length, data: { label: '访客6105' } })
assert.equal(authorRule.match('帮我改标题', 0), undefined, '普通消息不切节点')
assert.equal(authorRule.match('〔@阿伟〕\n你好', 7), undefined, '只认开头那一段，避免规则循环')
assert.ok(authorRule.order < 10, '要排在 session 引用规则之前')

const chip = moduleExports.__test.AuthorChip({ node: { id: 'room-author', data: { label: '访客6105' } } })
assert.equal(chip.props.className, 'dsh-room-author')
const chipParts = chip.children.map((child) => child && child.props && child.props.className)
assert.deepEqual(chipParts, ['dsh-room-authoravatar', 'dsh-room-authorname'])
assert.equal(chip.children[0].children[0], '05', '默认名取尾号，头像不撞')
assert.equal(chip.children[1].children[0], '访客6105')
assert.equal(chip.props.title.includes('访客6105'), true)

// 注册：能拿到 uiConversation 服务就装规则 + 插槽条目；拿不到就安静返回 false
let authorRuleRegistered = null
let authorSlot = null
const authorCtx = {
  get(name) {
    if (name !== 'uiConversation') return null
    return { userText: { register(rule) { authorRuleRegistered = rule } } }
  },
  slots: {
    register(spec, component) {
      authorSlot = { spec, component }
      return { spec, component }
    },
  },
}
assert.equal(moduleExports.__test.installAuthorChip(authorCtx), true)
assert.equal(authorRuleRegistered, authorRule)
assert.equal(authorSlot.spec.name, 'conversation.user.text.node')
assert.equal(authorSlot.spec.key, 'room-author')
assert.equal(authorSlot.component, moduleExports.__test.AuthorChip)
assert.equal(moduleExports.__test.installAuthorChip({ get() { return null }, slots: null }), false, '没有服务时安静失败')

// 8. 本地发话人也打标（房主直连 DSH，请求不走代理，只能在浏览器里补）
const mark = moduleExports.__test.markPromptBodyClient
const bodyOf = (text) => JSON.stringify({
  type: 'client-request',
  rpcId: 'r-1',
  method: 'session/prompt',
  payload: { args: { request: { sessionId: 's1', mode: 'queue', content: [{ type: 'text', text }] } } },
})
const markedBody = JSON.parse(mark(bodyOf('帮我看看这个 bug'), '房主'))
assert.equal(markedBody.payload.args.request.content[0].text, '〔@房主〕\n帮我看看这个 bug')
assert.equal(markedBody.rpcId, 'r-1', '信封其它字段不动')
assert.equal(mark(mark(bodyOf('你好'), '房主'), '房主'), mark(bodyOf('你好'), '房主'), '幂等，不叠加')
assert.equal(mark('not json', '房主'), 'not json')
assert.equal(mark(bodyOf('你好'), ''), undefined === undefined ? mark(bodyOf('你好'), '') : '', '空名字也要有个兜底')
assert.equal(JSON.parse(mark(bodyOf('你好'), '')).payload.args.request.content[0].text, '〔@房主〕\n你好', '空名字回落到「房主」')
assert.equal(moduleExports.__test.localIdentityName(), '房主', '没加入房间时房主本机就是房主')
assert.equal(moduleExports.__test.isPromptUrl('/api/session/prompt'), true)
assert.equal(moduleExports.__test.isPromptUrl('/api/session/list'), false)

// 真的要改写发出去的请求体（Request 字符串体路径）
globalThis.window.__dshRoomDenyHook = false
let sentBody = null
globalThis.window.fetch = function (input, init) {
  sentBody = init && typeof init.body === 'string' ? init.body : null
  return Promise.resolve({ status: 200, clone() { return { text: () => Promise.resolve('{}') } } })
}
assert.equal(moduleExports.__test.installDenyNotice(), true)
await globalThis.window.fetch('/api/session/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyOf('改一下标题') })
assert.ok(sentBody, '请求体还是要发出去')
assert.equal(JSON.parse(sentBody).payload.args.request.content[0].text, '〔@房主〕\n改一下标题', '发出去的正文必须带身份标记')
// 非 prompt 请求一个字节都不改
sentBody = null
await globalThis.window.fetch('/api/session/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyOf('不该被改') })
assert.equal(JSON.parse(sentBody).payload.args.request.content[0].text, '不该被改')

// 9. 房客页：只留工作区 + 左下角改成「我的身份」（昵称/头像只存本地）
const profileApi = moduleExports.__test
assert.equal(profileApi.readGuestProfile(), null)
profileApi.writeGuestProfile({ name: '小鹿', avatar: '🦊' })
assert.deepEqual(profileApi.readGuestProfile(), { name: '小鹿', avatar: '🦊' })
assert.equal(profileApi.guestDisplayName(), '小鹿', '本地昵称优先')
assert.equal(profileApi.isGuestPage(), false, '没加入房间时不是房客页')
// 房客身份（模拟 saveGuest 写进去的记录）
globalThis.localStorage.setItem('dsh-room.guest', JSON.stringify({ addr: 'http://172.16.1.130:8787', token: 'tok', name: '访客6105' }))
assert.equal(profileApi.isGuestPage(), true)
globalThis.localStorage.removeItem(profileApi.STORAGE_PROFILE)
assert.equal(profileApi.guestDisplayName(), '访客6105', '没改过本地昵称就用房间里的名字')
assert.equal(moduleExports.__test.localIdentityName(), '访客6105', '指令标记也跟着本地昵称')
profileApi.writeGuestProfile({ name: '小鹿', avatar: '🦊' })
assert.equal(moduleExports.__test.localIdentityName(), '小鹿')

// 停用侧栏其它入口：只留工作区 + 我们自己的按钮
function fakeEl(tag) {
  return {
    tagName: tag,
    nodeType: 1,
    attrs: {},
    children: [],
    parentElement: null,
    setAttribute(key, value) { this.attrs[key] = value },
    querySelectorAll() { return this.navs || [] },
    append(child) { child.parentElement = this; this.children.push(child); return child },
  }
}
const column = fakeEl('DIV')
const footArea = column.append(fakeEl('DIV'))
const actions = footArea.append(fakeEl('DIV'))
const mine = actions.append(fakeEl('BUTTON'))
const pluginButton = actions.append(fakeEl('BUTTON'))
const settingsArea = footArea.append(fakeEl('DIV'))
const nav = fakeEl('NAV')
column.navs = [nav]
globalThis.document.documentElement = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v } }
profileApi.tidyGuestSidebar(mine)
assert.equal(pluginButton.attrs['data-dsh-room-hidden'], '1', '页脚里的插件入口要藏起来')
assert.equal(settingsArea.attrs['data-dsh-room-hidden'], '1', '左下角的房主账号/设置区要藏起来')
assert.equal(nav.attrs['data-dsh-room-hidden'], '1', '侧栏的面板列表（插件/设置…）要藏起来')
assert.equal(mine.parentElement, actions, '自己的按钮留在原位')
assert.equal(mine.attrs['data-dsh-room-hidden'], undefined)
assert.equal(globalThis.document.documentElement.attrs['data-dsh-room-guest'], '1', '给 CSS 一个开关')

// 注入左下角按钮：纯 DOM，不依赖 React 插槽
const domRegistry = []
function domEl(tag, className) {
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    className: className || '',
    attrs: {},
    children: [],
    parentElement: null,
    firstChild: null,
    style: { setProperty(key, value) { this[key] = value } },
    textContent: '',
    title: '',
    type: '',
    value: '',
    listeners: {},
    appendChild(child) {
      child.parentElement = this
      this.children.push(child)
      this.firstChild = this.children[0]
      domRegistry.push(child)
      return child
    },
    removeChild(child) {
      this.children = this.children.filter((item) => item !== child)
      this.firstChild = this.children[0] || null
      child.parentElement = null
      return child
    },
    setAttribute(key, value) { this.attrs[key] = value },
    getAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null },
    removeAttribute(key) { delete this.attrs[key] },
    get parentNode() { return this.parentElement },
    addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler) },
    focus() {},
    getBoundingClientRect() { return { left: 12, top: 700, right: 200, bottom: 726 } },
    querySelectorAll(selector) {
      if (selector === 'nav') return this.children.filter((child) => child.tagName === 'NAV')
      return []
    },
  }
  return el
}

function matchSelector(el, selector) {
  const text = selector.trim()
  let m = text.match(/^\[([\w-]+)\*="(.+)"\]$/)
  if (m) return String(el.className || '').indexOf(m[2]) >= 0
  m = text.match(/^\[([\w-]+)="(.*)"\]$/)
  if (m) return String(el.attrs[m[1]] === undefined ? '' : el.attrs[m[1]]) === m[2]
  m = text.match(/^\[([\w-]+)\]$/)
  if (m) return Object.prototype.hasOwnProperty.call(el.attrs, m[1])
  m = text.match(/^([a-z]+)$/)
  if (m) return el.tagName === m[1].toUpperCase()
  return false
}

const bodyEl = domEl('BODY')
domRegistry.push(bodyEl)
const fakeDocument = {
  readyState: 'complete',
  documentElement: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v }, getAttribute(k) { return this.attrs[k] || null } },
  body: bodyEl,
  createElement(tag) { return domEl(tag) },
  querySelector(selector) { return fakeDocument.querySelectorAll(selector)[0] || null },
  querySelectorAll(selector) {
    const results = []
    const visit = (el) => {
      if (selector.split(',').some((part) => matchSelector(el, part))) results.push(el)
      el.children.forEach(visit)
    }
    bodyEl.children.forEach(visit)
    return results
  },
  addEventListener() {},
  getElementById() { return null },
}
globalThis.document = new Proxy(globalThis.document, {
  get(target, key) {
    if (key in fakeDocument) return fakeDocument[key]
    return target[key]
  },
})

// 房客页：插槽没渲染也能出现按钮（先浮在左下角），侧栏出现后挪进 footerActions
const footerHolder = domEl('DIV', 'xyz_footerActions')
footerHolder.getBoundingClientRect = () => ({ left: 12, top: 700, width: 220, height: 28, bottom: 728, right: 232 })
bodyEl.appendChild(footerHolder)
profileApi.sweepGuestChrome()   // 有房客记录 → 自动激活
let meChip = globalThis.document.querySelector('[data-dsh-room-me]')
assert.ok(meChip, '房客页必须有「我的身份」按钮')
assert.equal(meChip.parentElement.className, 'xyz_footerActions', '按钮要挂在侧栏页脚里')
assert.equal(meChip.getAttribute('data-floating'), null, '能挂进页脚就不浮动')
assert.equal(String(meChip.title).indexOf('小鹿') >= 0, true, '按钮上写着本地昵称')

// 侧栏收起（页脚 0 尺寸）时退回浮动，别把按钮藏在看不见的地方
footerHolder.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, bottom: 0, right: 0 })
// 应用主体也挂一个 0 尺寸的兄弟节点：浮动时绝不能把它标成隐藏，否则整页空白
const appRoot = domEl('DIV', '')
appRoot.id = 'root'
appRoot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, bottom: 0, right: 0 })
bodyEl.appendChild(appRoot)
profileApi.sweepGuestChrome()
assert.equal(meChip.parentElement, bodyEl, '页脚不可见时应浮到 body 上')
assert.equal(meChip.getAttribute('data-floating'), '1')
assert.equal(appRoot.getAttribute('data-dsh-room-hidden'), null, '浮动时不许把 #root 的一级兄弟标成隐藏（会把整个界面藏掉）')
assert.equal(bodyEl.getAttribute('data-dsh-room-hidden'), null, 'body 自己也不许被标')
// 已经误标的要能自己摘掉
appRoot.setAttribute('data-dsh-room-hidden', '1')
profileApi.sweepGuestChrome()
assert.equal(appRoot.getAttribute('data-dsh-room-hidden'), null, '误标在应用主体上的隐藏属性要被摘掉')
bodyEl.removeChild(appRoot)
footerHolder.getBoundingClientRect = () => ({ left: 12, top: 700, width: 220, height: 28, bottom: 728, right: 232 })
profileApi.sweepGuestChrome()
assert.equal(meChip.parentElement.className, 'xyz_footerActions', '页脚回来后要挪回去')

// 点开编辑器：改昵称 + 选头像 → 只写 localStorage
profileApi.openGuestEditor(meChip)
const pop = globalThis.document.querySelector('[data-dsh-room-me-pop]')
assert.ok(pop, '点开要有小面板')
const descendants = []
const collect = (el) => { descendants.push(el); el.children.forEach(collect) }
pop.children.forEach(collect)
const input = descendants.find((el) => el.tagName === 'INPUT')
assert.ok(input, '面板里有昵称输入框')
const allButtons = descendants.filter((el) => el.tagName === 'BUTTON')
const save = allButtons.find((button) => button.textContent === '保存')
assert.ok(save, '面板里有保存按钮')
input.value = '阿鱼'
const fox = allButtons.find((button) => button.textContent === '🦊')
assert.ok(fox, '面板里有头像可选')
fox.listeners.click[0]()
save.listeners.click[0]()
assert.deepEqual(profileApi.readGuestProfile(), { name: '阿鱼', avatar: '🦊' }, '保存后只写本地')
assert.equal(meChip.title.indexOf('阿鱼') >= 0, true, '按钮立刻跟着改名')
assert.equal(globalThis.document.querySelector('[data-dsh-room-me-pop]'), null, '保存后关闭面板')

// ── 「这条是谁说的」标记：DSH 0.2.1 的 prompt 走 WebSocket，不走 HTTP / fetch ──
const promptFrame = JSON.stringify({
  type: 'client-request', rpcId: 'rpc-1', method: 'session/prompt',
  payload: { args: { request: { requestId: 'req-1', sessionId: 'sess-1', mode: 'queue', content: [{ type: 'text', text: '你好' }] } } },
})
const markedFrame = profileApi.markPromptFrame(promptFrame, '访客6229')
assert.ok(markedFrame, 'prompt 帧要被认出来并加标记')
const markedPayload = JSON.parse(markedFrame)
assert.equal(markedPayload.payload.args.request.content[0].text, '〔@访客6229〕\n你好', '标记要加在第一段文本前面')
assert.equal(markedPayload.method, 'session/prompt', '其它字段原样保留')
assert.equal(markedPayload.payload.args.request.sessionId, 'sess-1')
assert.equal(JSON.parse(promptFrame).payload.args.request.content[0].text, '你好', '原字符串不能被改坏')
assert.equal(profileApi.markPromptFrame(promptFrame, ''), null, '没有昵称就不打标记')
assert.equal(profileApi.markPromptFrame(markedFrame, '张三'), null, '已经有标记就不重复加')
assert.equal(profileApi.markPromptFrame(JSON.stringify({ type: 'client-request', method: 'session/list', payload: { args: {} } }), '张三'), null, '别的 RPC 一律不碰')
assert.equal(profileApi.markPromptFrame('{坏 json', '张三'), null, '坏 JSON 原样放过，不能把发送弄坏')
assert.equal(profileApi.markPromptFrame(null, '张三'), null, '非字符串原样放过')

// ── 账号行模式：按钮住进 DSH 的账号按钮里，只藏它原来的内容，不扫兄弟节点 ──
const accountTrigger = domEl('BUTTON', 'xyz_trigger')
const oldAvatar = accountTrigger.appendChild(domEl('SPAN', 'xyz_avatar'))
const oldLabel = accountTrigger.appendChild(domEl('SPAN', 'xyz_label'))
const accountChip = accountTrigger.appendChild(domEl('BUTTON', 'dsh-room-me'))
accountChip.setAttribute('data-account', '1')
const settingsWrap = domEl('DIV', 'xyz_settingsArea')
settingsWrap.appendChild(accountTrigger)
bodyEl.appendChild(settingsWrap)
profileApi.tidyGuestSidebar(accountChip)
assert.equal(oldAvatar.getAttribute('data-dsh-room-hidden'), '1', '账号行里原来的头像要藏起来')
assert.equal(oldLabel.getAttribute('data-dsh-room-hidden'), '1', '账号行里原来的「已登录 DeepSeek」要藏起来')
assert.equal(accountChip.getAttribute('data-dsh-room-hidden'), null, '我们自己的按钮不许被藏')
assert.equal(accountTrigger.getAttribute('data-dsh-room-hidden'), null, '账号按钮本身不许被藏')
assert.equal(settingsWrap.getAttribute('data-dsh-room-hidden'), null, '账号区容器不许被藏')

// 房主页：读不到房客记录时不会乱插按钮
globalThis.localStorage.removeItem('dsh-room.guest')
globalThis.document.querySelectorAll = () => []
assert.equal(typeof profileApi.installGuestChrome(), 'boolean')

console.log('dsh-room client smoke test: PASS')

