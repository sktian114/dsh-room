/**
 * 聊天群数据层的单测：跑 `node test/chat.test.mjs`。
 */
import assert from 'node:assert/strict'
import { createChatStore } from '../lib/chat.mjs'

let clock = 1000
const store = createChatStore({ now: () => (clock += 10) })

/* ── 1. 大厅自动存在，人自动属于所有群 ── */
const lobby = store.ensureLobby('大厅')
assert.equal(lobby.id, 'lobby')
assert.deepEqual(store.listGroups().map((group) => group.id), ['lobby'])

/* ── 2. 建群 / 重名 / 空名 ── */
const created = store.createGroup({ name: '前端小组' })
assert.ok(created.group && created.group.id.startsWith('c'))
assert.deepEqual(store.createGroup({ name: '   ' }), { error: 'bad-name' })
assert.deepEqual(store.createGroup({ name: '前端小组', id: created.group.id }), { error: 'exists' })
assert.equal(store.listGroups().length, 2)

/* ── 3. 收发消息 + 序号单调 ── */
const first = store.post({ from: { kind: 'host', id: 'host', name: '房主' }, text: ' 大家好 ' })
assert.equal(first.message.text, '大家好')
assert.equal(first.message.seq, 1)
const second = store.post({ groupId: created.group.id, from: { kind: 'user', id: 'g1', name: '阿伟' }, text: '在' })
assert.equal(second.message.seq, 2)
assert.deepEqual(store.post({ from: { kind: 'host', id: 'host' }, text: '   ' }), { error: 'empty' })
assert.deepEqual(store.post({ groupId: 'nope', from: { kind: 'host', id: 'host' }, text: 'x' }), { error: 'no-group' })

/* ── 4. 增量同步 ── */
assert.deepEqual(store.sync({ since: 1 }).messages.map((m) => m.seq), [2])
assert.equal(store.sync({ since: 0 }).seq, 2)
const lobbyView = store.listGroups()[0]
assert.equal(lobbyView.lastText, '大家好')
assert.equal(lobbyView.count, 1)
assert.equal(store.messagesOf(created.group.id).length, 1)
assert.equal(store.messagesOf('nope'), null)

/* ── 5. agent 成员：只能读写自己所在的群 ── */
assert.deepEqual(store.post({ from: { kind: 'agent', id: 'session-a', name: 'A' }, text: '偷偷说话' }), { error: 'not-member' })
const added = store.addAgent(created.group.id, { id: 'session-a', title: '重构助手' })
assert.equal(added.group.agents.length, 1)
// 重复拉同一个会话是幂等的：不报错、别名不变（「批量拉人抖动」就是重复拉人导致的）
const addedAgain = store.addAgent(created.group.id, { id: 'session-a', title: '重构助手' })
assert.equal(addedAgain.already, true)
assert.equal(addedAgain.agent.alias, added.agent.alias)
assert.equal(addedAgain.group.agents.length, 1)
assert.ok(store.isAgentMember(created.group.id, 'session-a'))
assert.equal(store.isAgentMember('lobby', 'session-a'), false)
const agentPost = store.post({ groupId: created.group.id, from: { kind: 'agent', id: 'session-a', name: '重构助手' }, text: '我来改' })
assert.equal(agentPost.message.from.kind, 'agent')
assert.equal(agentPost.message.seq, 3)
assert.deepEqual(store.removeAgent(created.group.id, 'session-a').ok, true)
assert.deepEqual(store.removeAgent(created.group.id, 'session-a'), { error: 'not-member' })

/* ── 6. 删群：大厅受保护 ── */
assert.deepEqual(store.removeGroup('lobby'), { error: 'lobby-protected' })
assert.deepEqual(store.removeGroup(created.group.id), { ok: true })
assert.equal(store.listGroups().length, 1)
assert.equal(store.messagesOf(created.group.id), null)

/* ── 7. 系统消息 + 「谁说过话」 ── */
const people = createChatStore({ now: () => 5000 })
people.ensureLobby()
const notice = people.post({ from: { kind: 'system', id: 'room', name: '系统' }, text: '阿伟 加入了房间' })
assert.equal(notice.message.from.kind, 'system')
assert.equal(notice.message.from.name, '系统')
// 系统提示不算「有人说话」
assert.deepEqual(people.speakerList(), [])
people.post({ from: { kind: 'user', id: 'g1', name: '阿伟' }, text: '大家好' })
people.post({ from: { kind: 'user', id: 'g2', name: '小鹿' }, text: '来了' })
people.post({ from: { kind: 'user', id: 'g1', name: '阿伟' }, text: '再说一句' })
const speakers = people.speakerList()
assert.deepEqual(speakers.map((item) => item.id), ['g1', 'g2'], 'speakers are listed by identity, most recent first')
assert.equal(speakers[0].name, '阿伟')
assert.equal(speakers[0].kind, 'user')
// 同一个人换名字说话，身份 id 不变 → 仍然算同一个人
people.post({ from: { kind: 'user', id: 'g1', name: '阿伟(手机)' }, text: '换个名字' })
assert.equal(people.speakerList().filter((item) => item.id === 'g1').length, 1)

/* ── 8. 消息上限（不无限增长） ── */
const small = createChatStore({ maxMessages: 50 })
small.ensureLobby()
for (let i = 0; i < 80; i++) small.post({ from: { kind: 'host', id: 'host' }, text: 'm' + i })
assert.equal(small.messagesOf('lobby').length, 50)
assert.equal(small.sync({ since: 0 }).messages.length, 50)
assert.equal(small.sync({ since: 0 }).seq, 80)

/* ── 9. 快照 / 还原：聊天记录与「谁是谁」（昵称 + 头像）重启后还在 ── */
{
  let saves = 0
  const live = createChatStore({ onChange: () => { saves += 1 } })
  live.ensureLobby('大厅')
  live.post({ from: { kind: 'host', id: 'host', name: '房主' }, text: '在吗' })
  live.post({ from: { kind: 'user', id: 'g1', name: '阿伟', avatar: 'data:image/png;base64,AAAA' }, text: '在' })
  assert.ok(saves >= 2, '每次写入都要通知宿主落盘')

  const snapshot = JSON.parse(JSON.stringify(live.snapshot()))
  const revived = createChatStore()
  assert.equal(revived.restore(snapshot), true, '快照能装回去')
  revived.ensureLobby('大厅')
  const restored = revived.messagesOf('lobby', 0, 50)
  assert.equal(restored.length, 2, '重启后消息还在')
  assert.equal(restored[1].from.name, '阿伟', '发言人名字也在')
  assert.equal(restored[1].from.avatar, 'data:image/png;base64,AAAA', '头像跟着消息一起存档')
  assert.equal(revived.sync({ since: 0 }).groups.length, 1, '群列表也在')
  const next = revived.post({ from: { kind: 'host', id: 'host', name: '房主' }, text: '继续' })
  assert.ok(next.message.seq > snapshot.seq, 'seq 接着往上涨，不会撞号')
  assert.equal(revived.restore(null), false, '坏存档不炸')
  assert.equal(revived.restore('乱码'), false, '非对象存档也不炸')
}

/* ── 10. 唯一别名 + 点名 + 未读游标（「38 个成员都分得清、点名能唤醒」） ── */
{
  const room = createChatStore({ now: () => 9000 })
  const group = room.createGroup({ name: 'agent聊天室' }).group
  const one = room.addAgent(group.id, { id: 'session-aaa111bb', title: 'dsh space' }).agent
  const two = room.addAgent(group.id, { id: 'session-aaa222cc', title: 'dsh space' }).agent
  const three = room.addAgent(group.id, { id: 'session-zzz999', title: '杂项' }).agent
  assert.notEqual(one.alias, two.alias, '同名会话靠别名区分')
  assert.ok(one.alias.includes('#'), '别名带会话尾号')
  const aliases = new Set([one.alias, two.alias, three.alias])
  assert.equal(aliases.size, 3, '38 个成员都分得清：别名唯一')

  // 点名：@别名 只命中那一个（标题是另一个别名的前缀也不能串）
  const hitOne = room.post({ groupId: group.id, from: { kind: 'user', id: 'g1', name: '阿伟' }, text: '在吗 @' + two.alias })
  assert.deepEqual(hitOne.message.mentions, [two.id])
  const hitTitle = room.post({ groupId: group.id, from: { kind: 'user', id: 'g1', name: '阿伟' }, text: '@杂项 看一下' })
  assert.deepEqual(hitTitle.message.mentions, [three.id])
  // 显式 to（房主面板 / 工具参数）也走同一套解析
  const hitTo = room.post({ groupId: group.id, from: { kind: 'host', id: 'host', name: '房主' }, text: '私聊', to: [three.alias] })
  assert.deepEqual(hitTo.message.mentions, [three.id])
  const idle = room.post({ groupId: group.id, from: { kind: 'host', id: 'host' }, text: '大家好' })
  assert.deepEqual(idle.message.mentions, [])

  // 未读游标：按 (成员, 群) 记，推进后不再算未读
  assert.equal(room.cursorOf(three.id, group.id), 0)
  assert.equal(room.pendingFor(three.id, group.id).length, 4, '四条消息都没读')
  room.setCursor(three.id, group.id, hitTo.message.seq)
  assert.equal(room.pendingFor(three.id, group.id).length, 1, '游标之后的那条还算未读')
  room.setCursor(three.id, group.id, idle.message.seq)
  assert.equal(room.pendingFor(three.id, group.id).length, 0, '推到最新就没有未读了')
  // 自己说的不算未读
  room.post({ groupId: group.id, from: { kind: 'agent', id: three.id, name: '杂项' }, text: '我说一句' })
  assert.equal(room.pendingFor(three.id, group.id).length, 0, '自己说的话不推给自己')
  assert.equal(room.pendingFor(two.id, group.id).length, 5, '别人看得见')

  // 游标与别名一起存档：重启后不会重复投递、也不会改名
  const saved = JSON.parse(JSON.stringify(room.snapshot()))
  const again = createChatStore()
  assert.equal(again.restore(saved), true)
  assert.equal(again.cursorOf(three.id, group.id), idle.message.seq, '重启后未读游标还在')
  const restoredAgents = again.listGroups().find((item) => item.id === group.id).agents
  assert.deepEqual(restoredAgents.map((item) => item.alias).sort(), [one.alias, two.alias, three.alias].sort())
}

/* ── 14. 分页不能再漏读（2026-10-25 审计）──
 * 以前 messagesOf 是 `filter(seq>since).slice(-limit)`：未读 60 条 + limit 50 会一次跳到
 * 最新一页，前 10 条既不再推送、也没法用 since 翻回来。
 */
{
  const room = createChatStore({ maxMessages: 500 })
  const group = room.ensureLobby('分页群')
  for (let i = 0; i < 60; i += 1) {
    room.post({ groupId: group.id, from: { kind: 'guest', id: 'g1', name: '阿伟' }, text: 'm' + (i + 1) })
  }
  const page1 = room.messagesOf(group.id, 0, 50)
  assert.equal(page1.length, 50, '第一页给 50 条')
  assert.equal(page1[0].text, 'm1', '第一页从最老的未读开始')
  assert.equal(page1[page1.length - 1].text, 'm50')
  const page2 = room.messagesOf(group.id, page1[page1.length - 1].seq, 50)
  assert.equal(page2.length, 10, '第二页只剩剩下的 10 条')
  assert.equal(page2[0].text, 'm51', '第二页接着第一页，不跳页')
  assert.equal(page2[page2.length - 1].text, 'm60')
  assert.equal(room.messagesOf(group.id, page2[page2.length - 1].seq, 50).length, 0, '读完就没有了')
}

/* ── 15. sync 不能因为群多而丢消息 ── */
{
  const room = createChatStore({ maxMessages: 20 })
  const a = room.createGroup({ name: 'A 群' }).group
  const b = room.createGroup({ name: 'B 群' }).group
  for (let i = 0; i < 5; i += 1) {
    room.post({ groupId: a.id, from: { kind: 'guest', id: 'g1', name: '阿伟' }, text: 'a' + (i + 1) })
  }
  for (let i = 0; i < 50; i += 1) {
    room.post({ groupId: b.id, from: { kind: 'guest', id: 'g1', name: '阿伟' }, text: 'b' + (i + 1) })
  }
  const synced = room.sync({ since: 0 }).messages
  const texts = synced.map((message) => message.text)
  assert.equal(texts.filter((text) => text.startsWith('a')).length, 5, 'A 群的消息不能被挤出窗口')
  assert.equal(texts.filter((text) => text.startsWith('b')).length, 50)
  assert.deepEqual(synced.map((m) => m.seq), synced.map((m) => m.seq).slice().sort((x, y) => x - y), '合并后按 seq 有序')
}

/* ── 16. 删群/删成员要一起清游标 ── */
{
  const room = createChatStore()
  const group = room.createGroup({ name: '临时群' }).group
  room.addAgent(group.id, { id: 'session-x', title: '临时助手' })
  room.setCursor('session-x', group.id, 7)
  assert.equal(room.cursorOf('session-x', group.id), 7)
  room.removeAgent(group.id, 'session-x')
  assert.equal(room.cursorOf('session-x', group.id), 0, '删成员清掉他的游标')
  room.addAgent(group.id, { id: 'session-y', title: '另一个助手' })
  room.setCursor('session-y', group.id, 9)
  room.removeGroup(group.id)
  assert.equal(room.cursorOf('session-y', group.id), 0, '删群清掉所有成员游标')
  const saved = JSON.stringify(room.snapshot())
  assert.equal(saved.indexOf(group.id) < 0, true, '存档里不再有删掉的群和它的游标')
}

console.log('dsh-room chat test: PASS')
