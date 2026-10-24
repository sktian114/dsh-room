/**
 * 房间聊天群的数据层（纯逻辑，可离线单测）。
 *
 * 设计口径：
 *   · 房间里的「人」（房主 + 访客）自动属于所有群，不需要入群申请。
 *   · 「agent」= 房主工作区里的 DSH 会话，由房主手动拉进某个群；agent 只能读写
 *     自己被拉进的群。
 *   · 消息默认只在内存里；传了 `onChange` 回调时，每次写入都会通知宿主落盘
 *     （`snapshot()` / `restore()` 用来把整份聊天记录存进磁盘再读回来）。
 *   · 全局序号 seq 单调递增，**跨群共享**（不是群内自增）；客户端靠 `since` 增量拉取。
 *   · 每个 agent 有唯一别名 `标题#前6位`（同名自动加序号），点名靠别名。
 *   · 未读游标按 (成员, 群) 记 lastSeenSeq：宿主据此决定还该给谁投递哪几条。
 */

const MAX_TEXT = 2000
const MAX_NAME = 40
const MAX_ALIAS = 48

let fallbackCounter = 0

function makeId(prefix) {
  fallbackCounter += 1
  return prefix + Date.now().toString(36) + fallbackCounter.toString(36)
}

/** 会话 id → 别名的尾段：`session-ab12cd34-…` → `ab12cd`。 */
function aliasTail(id) {
  const raw = String(id || '').replace(/^session-/, '').replace(/[^0-9a-zA-Z]/g, '')
  return raw.slice(0, 6) || 'x'
}

/** 别名：`标题#ab12cd`；标题太长只留末段，重复再补 -2 / -3。 */
function makeAlias(title, id, taken) {
  const short = String(title || '').replace(/\s+/g, ' ').trim()
  const head = (short.length > 14 ? short.slice(-14) : short) || 'agent'
  const base = (head + '#' + aliasTail(id)).slice(0, MAX_ALIAS)
  if (!taken || !taken.has(base)) return base
  for (let index = 2; index < 100; index += 1) {
    const next = (base + '-' + index).slice(0, MAX_ALIAS)
    if (!taken.has(next)) return next
  }
  return (base + '-' + makeId('')).slice(0, MAX_ALIAS)
}

/**
 * @param {{ now?: () => number, maxMessages?: number, onChange?: () => void }} [options]
 */
export function createChatStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const maxMessages = Math.max(50, Number(options.maxMessages) || 1000)
  const onChange = typeof options.onChange === 'function' ? options.onChange : null
  const groups = new Map()
  const recent = []
  // 谁说过话：id → { id, name, kind, at }。给「房客都是不同的人」这件事留一份可查的账。
  const speakers = new Map()
  // 未读游标：`成员id::群id` → 已经投递/读到过的最大 seq。
  const cursors = new Map()
  let seq = 0

  function touched() {
    if (!onChange) return
    try { onChange() } catch { /* 落盘失败不影响聊天 */ }
  }

  function clampName(value, fallback) {
    const name = String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)
    return name || fallback
  }

  function ensureGroup(id, name) {
    const key = String(id || '').trim()
    if (!key) return null
    let group = groups.get(key)
    if (!group) {
      group = {
        id: key,
        name: clampName(name, key),
        createdAt: now(),
        agents: new Map(),
        messages: [],
        count: 0,
        lastAt: 0,
        lastText: '',
      }
      groups.set(key, group)
    } else if (name) {
      group.name = clampName(name, group.name)
    }
    return group
  }

  function ensureLobby(name = '大厅') {
    return ensureGroup('lobby', name)
  }

  function createGroup(input = {}) {
    const name = clampName(input.name, '')
    if (!name) return { error: 'bad-name' }
    const id = input.id ? String(input.id) : makeId('c')
    if (groups.has(id)) return { error: 'exists' }
    const group = ensureGroup(id, name)
    touched()
    return { group: view(group) }
  }

  function removeGroup(id) {
    group(id) // 不存在的群按 no-group 处理
    const key = String(id || '')
    if (key === 'lobby') return { error: 'lobby-protected' }
    if (!groups.has(key)) return { error: 'no-group' }
    groups.delete(key)
    touched()
    return { ok: true }
  }

  function group(id) {
    return groups.get(String(id || '')) || null
  }

  function view(target) {
    if (!target) return null
    const group = groups.get(String(target)) || target
    return {
      id: group.id,
      name: group.name,
      createdAt: group.createdAt,
      count: group.count,
      lastAt: group.lastAt,
      lastText: group.lastText,
      agents: Array.from(group.agents.values()).map((agent) => ({
        id: agent.id,
        title: agent.title,
        alias: agent.alias,
        addedAt: agent.addedAt,
      })),
    }
  }

  function listGroups() {
    const list = Array.from(groups.values()).map((item) => view(item))
    list.sort((a, b) => {
      if (a.id === 'lobby') return -1
      if (b.id === 'lobby') return 1
      return (b.lastAt || b.createdAt || 0) - (a.lastAt || a.createdAt || 0)
    })
    return list
  }

  /** 全房间已在用的别名（跨群唯一，「38 个成员都分得清」靠这个）。 */
  function takenAliases() {
    const taken = new Set()
    for (const group of groups.values()) {
      for (const agent of group.agents.values()) if (agent.alias) taken.add(agent.alias)
    }
    return taken
  }

  function addAgent(groupId, agent = {}) {
    const target = group(groupId)
    if (!target) return { error: 'no-group' }
    const id = String(agent.id || '').trim()
    if (!id) return { error: 'bad-agent' }
    const existing = target.agents.get(id)
    // 重复拉同一个会话是幂等的：不产生系统事件、不改别名。
    if (existing) return { group: view(target), agent: { ...existing }, already: true }
    const title = clampName(agent.title, id)
    const record = {
      id,
      title,
      alias: String(agent.alias || '').trim().slice(0, MAX_ALIAS) || makeAlias(title, id, takenAliases()),
      addedAt: now(),
    }
    target.agents.set(id, record)
    touched()
    return { group: view(target), agent: { ...record } }
  }

  function removeAgent(groupId, agentId) {
    const target = group(groupId)
    if (!target) return { error: 'no-group' }
    const id = String(agentId || '').trim()
    if (!target.agents.delete(id)) return { error: 'not-member' }
    touched()
    return { ok: true, group: view(target) }
  }

  function isAgentMember(groupId, agentId) {
    const target = group(groupId)
    return Boolean(target && target.agents.has(String(agentId || '')))
  }

  /** 群里某个别名/标题/id 对应的 agent（点名解析用）。 */
  function agentByAlias(groupId, needle) {
    const target = group(groupId)
    const key = String(needle || '').trim().replace(/^@/, '')
    if (!target || !key) return null
    for (const agent of target.agents.values()) {
      if (agent.alias === key || agent.id === key || agent.title === key) return agent
    }
    return null
  }

  /**
   * 点名解析：`to: ['别名']` 优先，另外扫正文里的 `@别名` / `@标题`。
   * 边界要卡住：`@dsh space` 不能把 `@dsh space#aaa222` 也算上（别名更长者优先）。
   * 返回被点名的 agent id 列表（去掉发话人自己，避免自己叫自己）。
   */
  function resolveMentions(target, to, text, from) {
    const found = new Set()
    const selfId = String((from && from.id) || '')
    const push = (agent) => {
      if (agent && agent.id && agent.id !== selfId) found.add(agent.id)
    }
    for (const item of Array.isArray(to) ? to : to ? [to] : []) push(agentByAlias(target.id, item))
    const body = String(text || '')
    const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // 别名比标题长，先匹配别名；被别名命中的按 id 记下，后面标题匹配就跳过它。
    const byAlias = Array.from(target.agents.values())
      .filter((agent) => agent.alias)
      .sort((a, b) => b.alias.length - a.alias.length)
    for (const agent of byAlias) {
      if (new RegExp('@' + escapeRe(agent.alias) + '(?![#\\w-])').test(body)) push(agent)
    }
    for (const agent of target.agents.values()) {
      if (found.has(agent.id) || !agent.title) continue
      // 标题后面紧跟 `#`/`-`/字母数字，说明正文里写的是某个更长的别名，不算点名标题。
      if (new RegExp('@' + escapeRe(agent.title) + '(?![#\\w-])').test(body)) push(agent)
    }
    return Array.from(found)
  }

  // ---- 未读游标：投递到哪了 --------------------------------------------------

  function cursorKey(memberId, groupId) {
    return String(memberId || '') + '::' + String(groupId || '')
  }

  /** 这个成员在这个群已经读到（或已被投递到）的最大 seq。 */
  function cursorOf(memberId, groupId) {
    return cursors.get(cursorKey(memberId, groupId)) || 0
  }

  /** 推进游标（只增不减；返回推进后的值）。 */
  function setCursor(memberId, groupId, value) {
    const key = cursorKey(memberId, groupId)
    const next = Math.max(Number(value) || 0, cursors.get(key) || 0)
    if (next !== cursors.get(key)) {
      cursors.set(key, next)
      touched()
    }
    return next
  }

  /** 某个成员的未读条目（还没投递的消息）。 */
  function pendingFor(memberId, groupId) {
    const target = group(groupId)
    if (!target) return []
    const cursor = cursorOf(memberId, groupId)
    return target.messages.filter((message) => message.seq > cursor && message.from.id !== String(memberId))
  }

  /**
   * 发一条消息。
   *
   * kind 有四种：
   *   · host   —— 房主本人
   *   · user   —— 某个访客（id 是访客的稳定身份，不同 id 就是不同的人）
   *   · agent  —— 被拉进这个群的 DSH 会话
   *   · system —— 房间系统提示（谁进房、谁离房、谁被拉进群），不是人说的
   *
   * @param {{ groupId?: string, from: { kind: string, id: string, name?: string }, text: string, to?: string[] }} input
   */
  function post(input = {}) {
    const target = group(input.groupId || 'lobby')
    if (!target) return { error: 'no-group' }
    const from = input.from || {}
    const kind = String(from.kind || 'user')
    if (kind === 'agent' && !target.agents.has(String(from.id || ''))) return { error: 'not-member' }
    const text = String(input.text || '').trim().slice(0, MAX_TEXT)
    if (!text) return { error: 'empty' }
    const fallbackName = kind === 'agent' ? 'Agent' : kind === 'system' ? '系统' : '访客'
    const message = {
      seq: ++seq,
      at: now(),
      group: target.id,
      from: {
        kind,
        id: String(from.id || ''),
        name: clampName(from.name, fallbackName),
        avatar: String(from.avatar || '').slice(0, 200 * 1024),
      },
      text,
      // 点名：显式 to 参数 + 正文里的 @别名，都归到被点名的 agent id 上。
      mentions: resolveMentions(target, input.to, text, from),
    }
    target.messages.push(message)
    if (target.messages.length > maxMessages) target.messages.shift()
    target.count += 1
    target.lastAt = message.at
    target.lastText = text
    recent.push(message)
    if (recent.length > maxMessages) recent.shift()
    if (kind !== 'system') {
      speakers.set(message.from.id, { id: message.from.id, name: message.from.name, kind, at: message.at })
    }
    touched()
    return { message }
  }

  /** 说过话的身份列表（按最后发言时间倒序），给「谁是谁」用。 */
  function speakerList() {
    return Array.from(speakers.values()).sort((a, b) => b.at - a.at)
  }

  function messagesOf(groupId, since = 0, limit = 200) {
    const target = group(groupId)
    if (!target) return null
    const from = Number(since) || 0
    const size = Math.min(500, Math.max(1, Number(limit) || 200))
    return target.messages.filter((message) => message.seq > from).slice(-size)
  }

  /** 增量同步：群列表 + seq 之后的所有消息。 */
  function sync(input = {}) {
    const since = Number(input.since) || 0
    return {
      seq,
      groups: listGroups(),
      messages: since >= 0 ? recent.filter((message) => message.seq > since) : recent.slice(),
    }
  }

  /** 整份聊天记录 → 可写盘的结构（房主本地存档用）。 */
  function snapshot() {
    return {
      seq,
      groups: Array.from(groups.values()).map((group) => ({
        id: group.id,
        name: group.name,
        createdAt: group.createdAt,
        count: group.count,
        lastAt: group.lastAt,
        lastText: group.lastText,
        agents: Array.from(group.agents.values()),
        messages: group.messages.slice(-maxMessages),
      })),
      recent: recent.slice(-maxMessages),
      speakers: Array.from(speakers.values()),
      cursors: Array.from(cursors.entries()).map(([key, value]) => ({ key, seq: value })),
    }
  }

  /** 把 snapshot() 的结果装回来（重启后接着用，seq 继续递增，不会撞号）。 */
  function restore(state) {
    if (!state || typeof state !== 'object') return false
    try {
      groups.clear()
      recent.length = 0
      speakers.clear()
      cursors.clear()
      seq = Number(state.seq) || 0
      for (const raw of Array.isArray(state.groups) ? state.groups : []) {
        const id = String((raw && raw.id) || '').trim()
        if (!id) continue
        const group = ensureGroup(id, raw.name)
        group.createdAt = Number(raw.createdAt) || group.createdAt
        group.count = Number(raw.count) || 0
        group.lastAt = Number(raw.lastAt) || 0
        group.lastText = String(raw.lastText || '')
        for (const agent of Array.isArray(raw.agents) ? raw.agents : []) {
          if (!agent || !agent.id) continue
          const id = String(agent.id)
          const title = clampName(agent.title, id)
          group.agents.set(id, {
            id,
            title,
            // 老存档里没有别名：按现在的口径补一个，保证「38 个成员都分得清」。
            alias: String(agent.alias || '').trim().slice(0, MAX_ALIAS) || makeAlias(title, id, takenAliases()),
            addedAt: Number(agent.addedAt) || now(),
          })
        }
        for (const message of Array.isArray(raw.messages) ? raw.messages : []) {
          if (!message || typeof message.text !== 'string') continue
          group.messages.push(message)
        }
      }
      for (const message of Array.isArray(state.recent) ? state.recent : []) {
        if (!message || typeof message.text !== 'string') continue
        recent.push(message)
      }
      for (const speaker of Array.isArray(state.speakers) ? state.speakers : []) {
        if (!speaker || !speaker.id) continue
        speakers.set(String(speaker.id), speaker)
      }
      for (const cursor of Array.isArray(state.cursors) ? state.cursors : []) {
        if (!cursor || !cursor.key) continue
        cursors.set(String(cursor.key), Number(cursor.seq) || 0)
      }
      return true
    } catch {
      return false
    }
  }

  return {
    ensureLobby,
    createGroup,
    removeGroup,
    listGroups,
    group,
    view,
    addAgent,
    removeAgent,
    isAgentMember,
    agentByAlias,
    resolveMentions,
    post,
    messagesOf,
    speakerList,
    cursorOf,
    setCursor,
    pendingFor,
    sync,
    snapshot,
    restore,
    get seq() { return seq },
  }
}
