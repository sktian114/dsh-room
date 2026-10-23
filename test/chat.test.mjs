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
assert.deepEqual(store.addAgent(created.group.id, { id: 'session-a', title: '重构助手' }), { error: 'already-member' })
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

console.log('dsh-room chat test: PASS')
