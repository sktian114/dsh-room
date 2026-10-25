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

/**
 * 从 Cookie 头里取某个 cookie 的值。
 * 房客浏览器打 /api/*（例如 session/prompt）时，DSH 自己的请求不带我们的令牌参数，
 * 只有 cookie 会跟着走 —— 这就是代理认出「这条指令是谁发的」的唯一凭据。
 * 纯逻辑、可单测：畸形输入一律返回空串，不抛错。
 * @param {string} header 原始 Cookie 头，例如 `a=1; dsh_room_token=abc`
 * @param {string} name cookie 名
 * @returns {string}
 */
export function tokenFromCookie(header, name) {
  const raw = String(header || '')
  const want = String(name || '')
  if (!raw || !want) return ''
  for (const part of raw.split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    if (part.slice(0, at).trim() !== want) continue
    return part.slice(at + 1).trim()
  }
  return ''
}

function isBlockedEvent(name) {
  return BLOCKED_EVENTS.some((pattern) => pattern.test(String(name || '')))
}

export function createGuestGuard(options) {
  const isBlockedPath = options.isBlockedPath
  const modeForPath = options.modeForPath || (() => 'blocked')
  const endpoints = new Map() // streamId -> endpoint
  // 跨连接共享：房客的工作区映射是在 WS 上学的，HTTP 请求（session/create）要用到。
  const workspaces = options.workspaces || new Map() // workspaceId -> { path, sessionIds:Set }
  /* sessionId -> 该会话所属工作区路径。
   * 注意：这里**只缓存路径，不缓存权限模式**。房主随时可能把「可写」改回「只读」，
   * 缓存模式会让房客一直拿着旧权限（不刷新页面就一直能发指令），所以每次判定都按
   * 当前策略现算。 */
  const sessionPaths = options.sessionPaths || options.sessionModes || new Map()

  /** 守卫已经知道的「会话 → 工作区路径」（没学过返回空串）。宿主用它判断要不要去查一手。 */
  function sessionPath(sessionId) {
    return sessionPaths.get(String(sessionId || '')) || ''
  }

  function modeForSession(sessionId) {
    const path = sessionPaths.get(String(sessionId || ''))
    if (!path) return ''
    return modeForPath(path)
  }

  function rememberSessionMode(sessionId, modeOrPath) {
    if (!sessionId || !modeOrPath) return
    // 兼容旧调用：传进来的是模式时，记下当前该模式对应的工作区路径无从得知，直接忽略模式值
    if (modeOrPath === 'readonly' || modeOrPath === 'write' || modeOrPath === 'full' || modeOrPath === 'blocked') return
    sessionPaths.set(String(sessionId), String(modeOrPath))
  }

  function rememberWorkspace(item) {
    if (!item || typeof item !== 'object' || !item.workspaceId) return
    const sessionIds = new Set(Array.isArray(item.sessionIds) ? item.sessionIds : [])
    const path = String(item.path || '')
    workspaces.set(String(item.workspaceId), { path, sessionIds })
    for (const sessionId of sessionIds) rememberSessionMode(sessionId, path)
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

  /**
   * 把路径里的百分号编码还原成真身（`%70luginManager` → `pluginManager`、
   * `/api/pluginManager%2FsetBundle` → `.../pluginManager/setBundle`）。
   *
   * 为什么必须还原再判：上游 DSH 的路由通常会对 pathname 做一次 decode，
   * 而我们的「禁区前缀 / 需检查端点」是按明文写的。以前直接拿原始 pathname 比对，
   * 房客把字母或斜杠编码一下（`/api/%70luginManager/…`）就绕过了整张黑名单。
   * 解不动（畸形编码）就返回原串，让后面的规则按原样兜。
   */
  function decodedPathname(pathname) {
    let current = String(pathname || '')
    for (let round = 0; round < 3; round += 1) {
      let next = current
      try { next = decodeURIComponent(current) } catch { return current }
      if (next === current) return next
      current = next
    }
    return current
  }

  // 返回 null 放行；返回字符串 = 拒绝原因；'inspect-body' = 需要先读 body
  function judgeRequest(pathname, method, url) {
    // 原始串和解码后的串都要判：解码只是「多认一种写法」，不是替换
    const raw = String(pathname || '')
    const decoded = decodedPathname(raw)
    // 房主账号 / 全局设置 / 插件 / 任意代码执行：房客一律不给
    if (isHostOnlyEndpoint(endpointOf(raw)) || isHostOnlyEndpoint(endpointOf(decoded))) return 'host-only'
    if (method !== 'POST' && raw !== '/api/file' && decoded !== '/api/file') return null
    if (decoded === '/api/$events/result' || raw === '/api/$events/result') return 'approval-owner-only'
    if (decoded === '/api/file' || raw === '/api/file') {
      const target = url.searchParams.get('path') || ''
      if (target && isBlockedPath(target)) return 'workspace-blocked'
      return null
    }
    if (INSPECT_ENDPOINTS.has(raw) || INSPECT_ENDPOINTS.has(decoded)) return 'inspect-body'
    return null
  }

  /* ── 房客的「禁区」端点 ──
   * 房客是通过房间代理借用房主的登录态在操作，所以凡是「改房主账号 / 改全局设置 /
   * 装插件 / 跑任意代码 / 操作宿主终端」的端点，一律拒绝——这些跟共享工作区无关，
   * 只是被同一条登录态顺带授权了。
   * 用前缀匹配，新增同类端点也能自动挡住。
   */
  const HOST_ONLY_ENDPOINTS = [
    'account/', 'credentials/', 'settings/', 'pluginManager/', 'pluginMarket/',
    'pluginInventory/', 'pluginRegistryProbe/', 'dynamicCordisRunner/',
    'terminal/', 'directoryPicker/', 'job/', 'subagents/', 'goals/', 'schedule/',
    'remoteAccess/', 'cotTranslation/', 'officeToPdf/', 'llm/',
    'speech/configure', 'speech/prepare', 'speech/cancelPreparation', 'speech/transcribe',
    'userQuestions/',
    'workspace/create', 'workspace/delete', 'workspace/rename',
    'workspace/archiveSession', 'workspace/unarchiveSession',
    'workspace/pinSession', 'workspace/unpinSession', 'workspace/insertBefore',
    'workspace/insertSessionBefore', 'workspace/initializeDefault',
    'session/openWorkspacePath', 'session/initializeDefaultModel',
    'agentPresets/select',
  ]

  /** 读文件类端点：要按路径重新判定，别让房客读到没开放（或已封锁）的目录。 */
  const PATH_ENDPOINTS = new Set([
    'workspaceFiles/list',
    'workspaceFiles/read',
    'workspaceFiles/readBytes',
    'workspaceFiles/stat',
    'workspaceFiles/changes',
  ])

  function endpointOf(pathname) {
    // /api/<endpoint> → <endpoint>；其它通道（/api/$events/result 等）按原样比较
    const match = /^\/api\/(.+)$/.exec(String(pathname || ''))
    return match ? match[1] : ''
  }

  function isHostOnlyEndpoint(endpoint) {
    if (!endpoint) return false
    return HOST_ONLY_ENDPOINTS.some((prefix) => (
      prefix.endsWith('/') ? endpoint.startsWith(prefix) : endpoint === prefix
    ))
  }

  /** 会改变宿主状态 / 让 Agent 干活的端点：必须通过工作区模式判定。 */
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
    '/api/workspaceFiles/list',
    '/api/workspaceFiles/read',
    '/api/workspaceFiles/readBytes',
    '/api/workspaceFiles/stat',
    '/api/workspaceFiles/changes',
  ])

  function modeForTarget(args) {
    const path = pathForTarget(args)
    return path ? modeForPath(path) : ''
  }

  /** 目标工作区路径（session/create 的落点），认不出来返回空串。 */
  function pathForTarget(args) {
    const request = (args && args.request) || {}
    const direct = request.cwd || (args && args.cwd) || ''
    if (direct) return String(direct)
    const workspaceId = request.workspaceId || (args && args.workspaceId)
    if (workspaceId) return workspacePath(workspaceId)
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
    // 同 judgeRequest：信封是按「解码后的路径」分派的，这里也得按解码后的判，
    // 否则房客把路径编码一下就能跳过工作区/只读这一整套判定。
    const route = decodedPathname(pathname)

    if (route === '/api/session/create') {
      const mode = modeForTarget(args)
      if (!mode || mode === 'blocked') return { deny: 'workspace-blocked' }
      if (mode === 'readonly') return { deny: 'workspace-readonly' }
      // 连路径一起带回去：宿主用它把「新会话 → 工作区」记进守卫，
      // 否则房客刚建的会话马上发指令会被判成 workspace-blocked。
      return { create: { mode, path: pathForTarget(args) } }
    }
    if (!INSPECT_ENDPOINTS.has(route) && !INSPECT_ENDPOINTS.has(pathname)) return null

    // 「读某个路径」的端点：按该路径当前的权限现判，别让房客借会话绕过去。
    // 读操作不吃「只读」限制，只拦「已封锁」。
    if (PATH_ENDPOINTS.has(endpointOf(route)) || PATH_ENDPOINTS.has(endpointOf(pathname))) {
      const target = String((args && (args.path || (args.request && args.request.path))) || '')
      if (target) {
        const mode = modeForPath(target)
        if (!mode || mode === 'blocked') return { deny: 'workspace-blocked' }
      }
      return null
    }

    // 房客永远不能自己切权限（与目标会话状态无关）。
    if (route === '/api/commands/execute') {
      const line = String((args && args.line) || '')
      if (/^\/permission(\s|$)/i.test(line.trim())) return { deny: 'permission-locked' }
    }

    // 宿主机桌面操作（用本机程序打开路径）一律不给房客用。
    if (route === '/api/session/openWorkspacePath') return { deny: 'host-only' }
    // 全局设置不允许房客改（权限预设就是其中一个 ns）。
    if (route === '/api/settings/update') return { deny: 'host-only' }

    const request = (args && args.request) || {}
    const sessionId = String(
      request.sessionId ||
      (request.address && request.address.sessionId) ||
      (args && (args.agentId || args.sessionId)) ||
      '',
    )
    let mode = sessionId ? modeForSession(sessionId) : ''
    // 会话类端点**不再**采信请求体里的 cwd 兜底：那等于把「认不出的会话」的权限判定
    // 交给房客自己填的路径 —— 塞一个已开放目录就能操作封锁工作区里的会话
    // （2026-10-25 审计 H1）。只有非会话类端点才允许按 body 里的目标路径判。
    if (!mode && !sessionId && !/^\/api\/session\//.test(route)) mode = modeForTarget(args)
    if (!mode || mode === 'blocked') return { deny: 'workspace-blocked' }
    if (mode === 'readonly') return { deny: 'workspace-readonly' }

    if (route === '/api/commands/execute') {
      const line = String((args && args.line) || '')
      if (/^\/permission(\s|$)/i.test(line.trim())) return { deny: 'permission-locked' }
    }
    return null
  }

  function filterResponse(pathname, bodyText) {
    // 会话列表也是按解码后的路径认的：编码过的 `/api/session%2Flist` 一样要过滤
    if (pathname !== '/api/session/list' && decodedPathname(pathname) !== '/api/session/list') return null
    let payload
    try { payload = JSON.parse(bodyText) } catch { return null }
    const result = payload && payload.result
    const value = result && result.value
    if (!value || !Array.isArray(value.items)) return null
    // 顺手把「会话 → 工作区路径」记下来：房客的指令（session/prompt）只能这样认出
    // 这条会话属于哪个工作区、该不该放行。以前只靠 WS 的 workspace 帧学，
    // 只走 HTTP 的路径（以及刚创建的新会话）就会一直被判 workspace-blocked。
    for (const item of value.items) {
      if (!item) continue
      const sessionId = item.sessionId || (item.projections && item.projections.values && item.projections.values.sessionId)
      const cwd = item.cwd || (item.projections && item.projections.values && item.projections.values.workingDirectory)
      if (sessionId && cwd && !isBlockedPath(String(cwd))) rememberSessionMode(String(sessionId), String(cwd))
    }
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

  return {
    clientFrame,
    serverFrame,
    judgeRequest,
    judgeBody,
    filterResponse,
    workspacePath,
    sessionPath,
    rememberSessionMode,
    modeForSession,
    inspectEndpoints: INSPECT_ENDPOINTS,
  }
}
