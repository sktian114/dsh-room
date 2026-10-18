/**
 * 房客侧守卫：按「工作区共享策略」过滤 DSH 的 RPC 流量。
 *
 * 分两处：
 *   · WebSocket 帧（/api/remote.mux）：workspace/follow、session/control、session/follow、$events
 *   · HTTP 信封（POST /api/<endpoint>、GET /api/file）：请求判定 + 响应过滤
 *
 * 只做「隐藏 + 拒绝」，不改业务语义；未知结构一律放行（宁可少挡，也不把界面弄坏）。
 * 协议依据见 docs/protocol-notes.md。
 */

const BLOCKED_EVENTS = [/^approval\//, /^user-questions\//]

function isBlockedEvent(name) {
  return BLOCKED_EVENTS.some((pattern) => pattern.test(String(name || '')))
}

export function createGuestGuard(options) {
  const isBlockedPath = options.isBlockedPath
  const modeForPath = options.modeForPath || (() => 'blocked')
  const endpoints = new Map() // streamId -> endpoint
  // 跨连接共享：房客的工作区映射是在 WS 上学的，HTTP 请求（session/create）要用到。
  const workspaces = options.workspaces || new Map() // workspaceId -> { path, sessionIds:Set }
  const sessionModes = options.sessionModes || new Map() // sessionId -> 该会话所属工作区的模式

  function modeForSession(sessionId) {
    return sessionModes.get(String(sessionId || '')) || ''
  }

  function rememberSessionMode(sessionId, mode) {
    if (sessionId && mode) sessionModes.set(String(sessionId), mode)
  }

  function rememberWorkspace(item) {
    if (!item || typeof item !== 'object' || !item.workspaceId) return
    const sessionIds = new Set(Array.isArray(item.sessionIds) ? item.sessionIds : [])
    workspaces.set(String(item.workspaceId), { path: String(item.path || ''), sessionIds })
    const mode = modeForPath(String(item.path || ''))
    for (const sessionId of sessionIds) rememberSessionMode(sessionId, mode)
  }

  function workspacePath(workspaceId) {
    const known = workspaces.get(String(workspaceId || ''))
    return known ? known.path : ''
  }

  function sessionSets() {
    const allowed = new Set()
    const blocked = new Set()
    for (const workspace of workspaces.values()) {
      const target = isBlockedPath(workspace.path) ? blocked : allowed
      for (const sessionId of workspace.sessionIds) target.add(sessionId)
    }
    return { allowed, blocked }
  }

  function filterWorkspaceItems(value) {
    if (!value || typeof value !== 'object') return value
    const filtered = []
    if (value.type === 'baseline' || value.type === 'replace') {
      const payload = value.value || {}
      const items = Array.isArray(payload.items) ? payload.items : []
      for (const item of items) {
        rememberWorkspace(item)
        if (!isBlockedPath(item.path)) filtered.push(item)
      }
      const { allowed } = sessionSets()
      const keepSessions = (list) => (Array.isArray(list) ? list.filter((id) => allowed.has(id)) : list)
      value.value = Object.assign({}, payload, {
        items: filtered,
        archivedSessionIds: keepSessions(payload.archivedSessionIds),
        pinnedSessionIds: keepSessions(payload.pinnedSessionIds),
      })
      return value
    }
    if (value.type === 'upsert') {
      rememberWorkspace(value.workspace)
      if (value.workspace && isBlockedPath(value.workspace.path)) return null
      if (value.workspace && Array.isArray(value.workspace.sessionIds)) {
        const { allowed } = sessionSets()
        value.workspace = Object.assign({}, value.workspace, {
          sessionIds: value.workspace.sessionIds.filter((id) => allowed.has(id)),
        })
      }
      return value
    }
    if (value.type === 'remove') {
      const known = workspaces.get(String(value.workspaceId || ''))
      workspaces.delete(String(value.workspaceId || ''))
      if (known && isBlockedPath(known.path)) return null
      return value
    }
    if (value.type === 'order') {
      if (!Array.isArray(value.workspaceIds)) return value
      const visible = value.workspaceIds.filter((id) => {
        const known = workspaces.get(String(id))
        return !known || !isBlockedPath(known.path)
      })
      value.workspaceIds = visible
      return value
    }
    if (value.type === 'archived' || value.type === 'pinned') {
      const { allowed } = sessionSets()
      const key = value.type === 'archived' ? 'archivedSessionIds' : 'pinnedSessionIds'
      if (Array.isArray(value[key])) value[key] = value[key].filter((id) => allowed.has(id))
      return value
    }
    return value
  }

  function filterSessionControl(value) {
    const { blocked } = sessionSets()
    if (!blocked.size || !value || typeof value !== 'object') return value
    if (value.type === 'baseline') {
      const payload = value.value || {}
      const projections = payload.projections || {}
      const next = {}
      for (const sessionId of Object.keys(projections)) {
        if (!blocked.has(sessionId)) next[sessionId] = projections[sessionId]
      }
      value.value = Object.assign({}, payload, { projections: next })
      return value
    }
    if (value.type === 'projection' && blocked.has(String(value.sessionId || ''))) return null
    return value
  }

  /* ── WebSocket 帧 ── */

  // 房客不许碰宿主的终端流（attach 可写输入），以及其它明显越权的流。
  const BLOCKED_STREAMS = /^(terminal|jobs|workflow)\//

  function clientFrame(frame) {
    if (frame && frame.type === 'open' && frame.streamId) {
      const endpoint = String(frame.endpoint || '')
      if (BLOCKED_STREAMS.test(endpoint)) return null
      endpoints.set(String(frame.streamId), endpoint)
    }
    return frame
  }

  function serverFrame(frame) {
    if (!frame || typeof frame !== 'object') return frame
    const endpoint = endpoints.get(String(frame.streamId || '')) || ''
    if (frame.type === 'item') {
      if (endpoint === 'workspace/follow') {
        const filtered = filterWorkspaceItems(frame.value)
        if (!filtered) return null
        frame.value = filtered
        return frame
      }
      if (endpoint === 'session/control') {
        const filtered = filterSessionControl(frame.value)
        if (!filtered) return null
        frame.value = filtered
        return frame
      }
      if (endpoint === '$events') {
        const value = frame.value || {}
        if ((value.type === 'waterfall' || value.type === 'emit') && isBlockedEvent(value.event)) return null
        return frame
      }
      if (endpoint === 'session/follow') {
        const { blocked } = sessionSets()
        const value = frame.value || {}
        const id = (value.header && value.header.id) || value.sessionId
        if (id && blocked.has(String(id))) return null
        return frame
      }
    }
    return frame
  }

  /* ── HTTP ── */

  // 返回 null 放行；返回字符串 = 拒绝原因；'inspect-body' = 需要先读 body
  function judgeRequest(pathname, method, url) {
    if (method !== 'POST' && pathname !== '/api/file') return null
    if (pathname === '/api/$events/result') return 'approval-owner-only'
    if (pathname === '/api/file') {
      const target = url.searchParams.get('path') || ''
      if (target && isBlockedPath(target)) return 'workspace-blocked'
      return null
    }
    if (INSPECT_ENDPOINTS.has(pathname)) return 'inspect-body'
    return null
  }

  // 会改变宿主状态 / 让 Agent 干活的端点：必须通过工作区模式判定。
  const INSPECT_ENDPOINTS = new Set([
    '/api/session/create',
    '/api/session/prompt',
    '/api/session/cancel',
    '/api/session/updateQueue',
    '/api/session/rename',
    '/api/session/fork',
    '/api/session/selectModel',
    '/api/session/openWorkspacePath',
    '/api/commands/execute',
    '/api/settings/update',
  ])

  function modeForTarget(args) {
    const request = (args && args.request) || {}
    const direct = request.cwd || (args && args.cwd) || ''
    if (direct) return modeForPath(String(direct))
    const workspaceId = request.workspaceId || (args && args.workspaceId)
    if (workspaceId) {
      const path = workspacePath(workspaceId)
      if (path) return modeForPath(path)
    }
    return ''
  }

  /**
   * 判定房客的 POST 信封。
   * @returns null | { deny: string } | { create: { mode: string } }
   */
  function judgeBody(pathname, bodyText) {
    let payload
    try { payload = JSON.parse(bodyText) } catch { return null }
    const args = payload && payload.payload && payload.payload.args

    if (pathname === '/api/session/create') {
      const mode = modeForTarget(args)
      if (!mode || mode === 'blocked') return { deny: 'workspace-blocked' }
      if (mode === 'readonly') return { deny: 'workspace-readonly' }
      return { create: { mode } }
    }
    if (!INSPECT_ENDPOINTS.has(pathname)) return null

    // 房客永远不能自己切权限（与目标会话状态无关）。
    if (pathname === '/api/commands/execute') {
      const line = String((args && args.line) || '')
      if (/^\/permission(\s|$)/i.test(line.trim())) return { deny: 'permission-locked' }
    }

    // 宿主机桌面操作（用本机程序打开路径）一律不给房客用。
    if (pathname === '/api/session/openWorkspacePath') return { deny: 'host-only' }
    // 全局设置不允许房客改（权限预设就是其中一个 ns）。
    if (pathname === '/api/settings/update') return { deny: 'host-only' }

    const request = (args && args.request) || {}
    const sessionId = String(
      request.sessionId ||
      (request.address && request.address.sessionId) ||
      (args && (args.agentId || args.sessionId)) ||
      '',
    )
    let mode = sessionId ? modeForSession(sessionId) : ''
    if (!mode) mode = modeForTarget(args)
    if (!mode || mode === 'blocked') return { deny: 'workspace-blocked' }
    if (mode === 'readonly') return { deny: 'workspace-readonly' }

    if (pathname === '/api/commands/execute') {
      const line = String((args && args.line) || '')
      if (/^\/permission(\s|$)/i.test(line.trim())) return { deny: 'permission-locked' }
    }
    return null
  }

  function filterResponse(pathname, bodyText) {
    if (pathname !== '/api/session/list') return null
    let payload
    try { payload = JSON.parse(bodyText) } catch { return null }
    const result = payload && payload.result
    const value = result && result.value
    if (!value || !Array.isArray(value.items)) return null
    const { blocked } = sessionSets()
    value.items = value.items.filter((item) => {
      if (!item) return false
      if (item.sessionId && blocked.has(String(item.sessionId))) return false
      if (item.cwd && isBlockedPath(String(item.cwd))) return false
      const projections = item.projections && item.projections.values
      if (projections && projections.workingDirectory && isBlockedPath(String(projections.workingDirectory))) return false
      return true
    })
    return JSON.stringify(payload)
  }

  return { clientFrame, serverFrame, judgeRequest, judgeBody, filterResponse, workspacePath, rememberSessionMode, modeForSession }
}
