# 1.0 之前的开发期，按 SemVer 预发布 / 小版本推进。

## 0.3.4 — 2026-10-24

### 会话里的「头像 + 昵称胶囊」终于能显示了（根因：作者标记从来没打上）+ 房客发指令被误拦

用 CDP 在真实页面上一路查到根因，三个叠在一起的问题：

1. **DSH 0.2.1-rc.3 发 prompt 用的是相对地址 `api/session/prompt`（没有前导斜杠）**，
   而客户端 hook 判断的是 `indexOf("/api/session/prompt") >= 0` → 永远 -1，
   **标记一次都没打过**。胶囊不显示不是渲染问题，是正文里根本没有 `〔@名字〕`。
   改成 `/(^|\/)api\/session\/prompt(\?|#|$)/`，两种写法都认（403 拒绝提示的 `/api/` 判断同样修）。
2. **代理侧也认不出人**：`authMember()` 只看 URL 上的 `token` / `Authorization` / `x-room-token`，
   而房客页打 `/api/*` 时一样都不带 → 代理这边也没法打标。
   现在 `/room/api/join` 会顺手下发 `dsh_room_token` cookie（HttpOnly 不需要，SameSite=Lax，7 天），
   `authMember()` 增加 cookie 兜底；解析逻辑抽成纯函数 `tokenFromCookie()`（lib/guard.mjs，有单测）。
3. **房客的指令被误判成 `workspace-blocked`**：守卫判断 `session/prompt` 要看「这条会话属于哪个工作区」，
   那份映射以前只从 WS 的 workspace 帧里学。结果是
   · 只走 HTTP 的场景（以及刚建好的新会话）一直判不出工作区 → 房客发什么都没反应；
   · `session/create` 回执里传的是**模式**而不是**路径**，`rememberSessionMode()` 明确忽略模式值 → 白记。
   现在 `session/list` 回执会把 `会话 → cwd` 记进守卫，`judgeBody('/api/session/create')` 连路径一起返回，
   宿主按路径登记。房客于是能在房主开放的工作区里正常发指令。

- 顺带把地址标签、文案统一成「虚拟内网」的收尾（见 0.3.1）做完；未联动任何具体组网产品。
- 测试：`npm test` 六套全绿。新增覆盖 —— `tokenFromCookie()` 的七种畸形输入、
  `session/list` 记住工作区后 `session/prompt` 放行 / 封锁工作区仍拦 / 从没见过的会话仍拒、
  `session/create` 回执带路径、加入房间下发 cookie。
- 真机验证（CDP，房客页）：注入一段 `〔@小鹿〕…` 后 DOM 兜底把标记原地换成胶囊
  `<span class="dsh-room-author">`（头像缩写 + 昵称，`title="这条指令来自：小鹿"`）。

## 0.3.3 — 2026-10-24

### 点名的会话没在跑 = 唤不醒 —— 补上「先恢复会话再唤醒」

- 真机第三次验收：0.3.2 上 `@杂项` 拿到 `pushed:{woke:0, skipped:37}`。
  原因不是投递坏了，而是**重启后所有会话都没在跑**：`ctx.agents.get(id)` 只认活着的实例，
  休眠会话一律查不到 → 以前只能跳过（等于「点名也唤不醒一个关着的会话」）。
- 修法：点名（或房主召唤）命中一个没有活句柄的成员时，先调 DSH 的
  `agents.resolveAgent(sessionId)` —— 它从 persistence 把会话读回来、组装成活的 agent
  （也可能返回 `{ error }`，按失败处理）—— 拿到句柄后再 `followup` 唤醒。
  **只有被点名的那个**会被恢复，别的成员依旧只走静默 inject 或跳过，不会对全群做恢复。
- 投递改成异步：点名唤醒可能要等会话恢复（秒级），`/api/chat/send` 与 `room_chat_post`
  用 8 秒上限（`DSH_ROOM_PUSH_TIMEOUT_MS` 可调）等结果；超时只是「不再等」，
  后台投递仍会跑完并推进游标，聊天本身不会被卡住。
- `/api/host/chat/wake`（房主召唤）走同一条路：休眠会话也会被恢复再唤醒；
  并且**不再顺手推进未读游标** —— 召唤不是「替它读过了」，推进会让它之后默认 read 读到空。
- `agentHandleOf` 增加 `get()` 落空后按 `list()` 兜底（id / sessionId / session.id 三种键），
  避免「明明在跑却说会话不在」。
- 测试：host 测试新增「休眠会话被点名 → 恢复 + followup」「恢复不出来 → 跳过不抛错」
  「get 落空按 list 兜住」三段。

## 0.3.2 — 2026-10-24

### 真机验收第二次：投递到了、会话却被 DSH 拒收 —— source kind 用了已退役写法

- 0.3.1 上 `ping` 自检 `agentService:true`，点名一条消息拿到 `pushed:{woke:1, skipped:36}`，
  说明**投递链路通了**；但被唤醒的会话当场报
  「本轮运行失败：format v4 message requires a producer-owned source kind」。
- 根因：`source` 用了 `{ kind: 'plugin', plugin: '@sktian114/dsh-room' }`。
  DSH 的 v4 会话格式只接受 **producer-owned** 的 source kind，`kind: 'plugin'` 是退役包装
  （`dsh-session-format-v3-to-v4` 的 `source()` 见到 `kind === 'plugin'` 直接抛错），
  写进会话日志时被拒，整轮作废。
- 修法：改成 DSH 自己的规范形态 `{ kind: 'plugin:@sktian114/dsh-room' }`
  （`producerKind()` 对插件生产者返回的就是 `plugin:<包名>`；非空且不为 `plugin` 的 kind 原样保留）。
  host 测试加了断言，锁死「不能再用 `kind:'plugin'`，也不能带 `plugin` 字段」。

## 0.3.1 — 2026-10-24

### 真机验收抓到的 P0 根因：插件没拿到 agent 句柄服务 + 文案统一成「虚拟内网」

- **真机验收（在群里 @杂项 点名）第一次跑出来的是 `pushed: {delivered:0, woke:0, skipped:37}`**：
  37 个成员一个都没投递。根因不是投递逻辑，而是**取不到 agent 服务** ——
  `ctx.agents` 只有在插件声明/注入这个服务之后才存在，而本插件的
  `export const inject` 只写了 `['webServer','connection']`，于是 `ctx.agents` 恒为 `undefined`，
  每个成员都被当成「会话不在」跳过。
- **修法**：用 DSH 自己的标准写法 `ctx.inject(['agents'], (scoped) => …)` 拿一次
  （DSH 内部插件 `ArchivedSessionGate`／`SubagentManager` 都是这么拿的），
  取用顺序变成「scoped 注入的 registry → `ctx.agents` → `ctx.get('agents')`」，
  三条都拿不到就退化成「只读不推」，不会让房间起不来。
- `/room/api/ping` 新增两个自检字段：`chatPush`（投递是否开启）、`agentService`（是否接上 agent 服务）。
  验收时先看这两个，不用再猜。
- **文案统一为「虚拟内网」，删掉一切绑定具体组网产品的字样**：
  地址标签从 `蒲公英 / 蒲公英·虚拟内网 / 虚拟局域网` 改成 `虚拟内网`
  （网卡识别正则也不再包含任何产品名）；README、SECURITY.md、宿主文件头注释、
  房客页的连接失败提示一起改成「同一 Wi-Fi，或任意虚拟内网工具」。
  仓库里 `蒲公英` / `pgy` / `oray` / `sunlogin` / `花生壳` 字样已清零，host 测试里加了断言防回归。

## 0.3.0 — 2026-10-24

### 群消息真正投递（P0）+ 唯一别名与点名（P1）+ seq 语义写清楚（P2）

这一版处理的是「杂项」在群里交的 3 条问题清单（2026-10-24 15:41，群 `cmvm2v3l41`）：

- **P0｜没有推送，群聊退化成留言板 → 已修**：
  宿主侧新增投递层 `deliverChatMessage()`。有人往群里发消息，立刻把这条消息投给群里
  每个**在线** agent 的收件箱：
  - 默认 `agent.inject({ content, source })` —— 静默落进它下一次被接纳的步骤，**不唤醒**；
  - 被点名（`to` / `@别名`）或房主在面板点「召唤」时改走 `agent.followup()` —— 这条才**唤醒**；
  - 会话已结束（`ctx.agents.get(id)` 拿不到句柄）就跳过，不排队不重试；
    投递失败绝不冒泡（只 warn），聊天本身不受影响。
  - 用 `agent.inject` 而不是 `agent/pre-step`：DSH 的 agent 句柄是公开 API
    （`handle.agent.followup / steer / inject / whenIdle`），不需要动 DSH 本体。
- **P0 配套｜未读游标 → 已做**：
  `(成员id::群id) → lastSeenSeq` 记在聊天层，跟着 `dsh-room-store.json` 一起落盘。
  `room_chat_read` 读完自动推进；投递成功才推进；重启后不会重复投递、也不会漏。
  新成员入群时游标对齐到当前最新，入群前的旧消息不会被当未读推给它。
- **P1｜成员不可区分、点名无解 → 已修**：每个 agent 有唯一别名 `标题#会话尾号`
  （例如 `dsh space#aaa111`），同名自动加 `-2`；`room_chat_members` / `room_chat_list`
  都带别名；`room_chat_post` 新增 `to`（逗号分隔别名），正文里的 `@别名` 同样算点名。
  点名解析卡了词边界：`@dsh space` 不会把 `@dsh space#aaa222` 一起算上。
- **P1｜批量拉人有竞态 → 已修**：`addAgent` 幂等（重复拉返回 `already: true`，
  不加成员、不刷「被拉进群」系统提示）。以前重复勾选会让同一个会话反复进出群。
- **P2｜seq 语义未文档化 → 已补**：工具描述里写明 `seq` 是**房间全局**计数器、跨群共享，
  增量同步只能用 `since`，不许拿 seq 做算术。
- **P2｜工具描述缺「何时该读」→ 已补**：`room_chat_read` / `room_chat_post` 的描述里写明
  「看到新消息先读全上下文再回话」，并且投递正文里直接带上 `room_chat_read` 的调用提示。
- **新端点** `POST /room/api/host/chat/wake`（房主专用）：显式唤醒某个 agent
  （`followup` 一条「先读群再回话」的指令）；不支持时返回 `409 offline`。
- 配置开关：`chatPush: false` 或环境变量 `DSH_ROOM_CHAT_PUSH=0` 可整体关掉投递。
- **没做的部分（明确记录）**：面板上还没有「召唤」按钮（端点已就绪，UI 待接），
  访客与房主之间的未读只按群算，不做逐条已读回执。
- 测试：`npm test` 全绿。新增覆盖 —— 别名唯一与幂等拉人、`@别名`/`@标题`/`to` 三路点名解析、
  游标推进与「自己说的不算未读」、快照往返保住游标、宿主侧 inject/followup 分流、
  离线会话跳过、`room_chat_read` 读完游标到最新、房主召唤端点。

## 0.2.0 — 2026-10-24

### 头像可以自己上传、聊天与房客身份落盘、大标题回归、会话身份胶囊双保险

- **头像改成自己上传**：`我的身份` 面板里不再有 8 个 emoji 可选，改成一个「上传图片」入口
  （隐藏的 `input[type=file] accept="image/*"`）：选图后在浏览器里居中裁成 96×96 的 JPEG
  （约 6–14 KB）存进 `localStorage` 的 `dsh-room.guest.profile.v1`，并提供「用首字母」退回。
  旧版本存的 emoji 头像一律当作没有（回退首字母），不会被画到界面上。
  头像在成员列表、聊天气泡、左下角身份按钮、会话身份胶囊里统一走 `AvatarBubble` /
  `paintAvatarInto`：有图就是 `<img>`，没图就是首字母。
- **聊天记录与「谁是谁」落盘**：宿主把聊天群/消息/发言人以及每个房客的昵称+头像写进
  `~/.dsh/dsh-room-store.json`（0.8 秒合并写盘，`chat.mjs` 的 `snapshot()` / `restore()`），
  启动时读回来。DSH 重启、房间重开之后历史还在，`seq` 接着递增不会撞号。
  房间本身不自动重开（不会偷偷监听端口）。
- **新端点 `POST /room/api/profile?token=…`**：房客改昵称/头像时把身份交给房主存档；
  `cleanAvatar()` 只收 `data:image/(png|jpeg|webp|gif);base64,…` 或 http(s) 链接（≤200 KB），
  其余（比如 `javascript:`）一律丢弃；`/api/join` 也会带上头像，返回的 `self` 与成员列表都含 `avatar`。
- **房客页左上角大标题回来了**：DSH 的品牌块（logo + 标题）本身是个 `aria-label="新建会话"`
  的按钮，旧版「按无障碍名隐藏多余入口」把它一起藏掉，看起来就像标题消失。
  现在 `isBrandNode()` 永久豁免品牌块（`hide()` / `hideExtraGuestEntries()` 都跳过），
  并且每轮扫描会把误标在品牌块上的隐藏属性摘掉。
- **会话身份胶囊加了一层 DOM 兜底**：官方的 user-text 规则 + `conversation.user.text.node`
  插槽继续用，但不再唯一依赖它 —— 新增 `startAuthorChipPainter()`，每 1.5 秒扫一遍渲染出来的
  文本节点，把 `〔@名字〕` 原地换成同一个胶囊（头像取成员缓存 `avatarForName()`）。
  两条路互斥不冲突：规则先吃掉标记，DOM 就找不到它。
- **文案统一为「虚拟内网」**：面板副标题改成「同一网络内共享同一个 DSH 工作区」，连接失败的提示、
  加入页的提示、README 与宿主文件头注释都改成「同一局域网 / 任意虚拟内网工具
  （插件不绑定任何具体产品）」。地址排序仍会把虚拟内网排在前面。
- 测试：`npm test` 全绿。新增覆盖 —— 上传入口存在且只收图片、图片头像画成 `<img>`、
  emoji 旧值被丢弃、品牌块不被隐藏而真正的「新建会话」仍被隐藏、身份胶囊结构、
  `snapshot()`/`restore()` 往返（含头像与 `seq` 连续）、`/api/profile` 落盘与非法头像拒绝。

## 0.1.16 — 2026-10-24

### 「联机」按钮消失 / DSH 一重启就白屏崩溃的真因：客户端模块注册 id 不对

- **症状**：DSH 重启后输入框右侧的「联机」按钮不见了（房客身份栏、作者标记也一起消失）；
  把插件写进 `dsh.profile.bundles` 后更狠 —— 整个网页白屏
  `Failed to load plugins`，桌面版随后走「关闭所有插件」的恢复流程，profile 配置被重置。
- **真因**（在隔离 Host 里跑出来的原始报错）：
  `@sktian114/dsh-room/client.js&rev=…: loaded without registering "@sktian114/dsh-room" via __ModuleLoader__.load`
  —— 启动清单里的条目 id 是**包名** `@sktian114/dsh-room`，而 `lib/client.js` 里
  `window.__ModuleLoader__.load({ id: "dsh-room" })` 注册的是目录名，加载器认不出这个包，
  整批客户端模块直接判失败 → 页面白屏 → 桌面版按 fatal 处理。
- **修法**：`lib/client.js` 以包名注册（`id: "@sktian114/dsh-room"`），另外补一个
  `id: "dsh-room"` 的别名注册，转发到正式模块，老的无作用域安装路径也能命中。
- **加载方式也跟着改**：客户端半边只认 profile 的 `dsh.profile.bundles`（`"dsh-room"`，
  目录名形式），行由插件自带的 `cordis.patch.yml` 插入；profile 自己的
  `cordis.patch.yml` 里**不要**再 insert 同一个包（同一个包两个 Loader 行会让清单报
  multiple active Loader sources）。只用 insert 加载时宿主半边能跑、客户端半边永远不下发，
  页面上还看不到任何报错。
- **验证**：`npm test` 全绿（client 用例新增「按包名注册 + 别名转发」断言）；再用
  `resources/runtime` 里的宿主在隔离 profile 上单独起一个 DSH（不动用户 profile），
  页面正常启动、`联机` 按钮可见（`roomEntryCount: 1`，`dsh-room-launch`），
  `data-dsh-room-author="ready"`。

## 0.1.15 — 2026-10-24

### 会话里「这条是谁发的」胶囊终于会出现（真因：prompt 走 WebSocket，不走 HTTP）

- **真因**：0.1.7 给房客指令加 `〔@昵称〕` 标记，只在两处挂钩 —— 代理的 HTTP
  `/api/session/prompt` 与页面里的 `window.fetch` 兜底。可 DSH 0.2.1 的会话请求**全部走
  同一条 WS**（`/api/remote.mux` 的 `client-request` 帧，方法 `session/prompt`，参数在
  `payload.args.request.content[]`），两条老路都碰不到它。证据：宿主会话文件里
  `〔@` 命中 0 次；页面上 `data-dsh-room-author="ready"`（规则与插槽都挂好了）但
  `chips=0`。所以渲染那半边一直是对的，缺的是数据。
- **修法**：房客页在 `WebSocket.prototype.send` 上包一层，`session/prompt` 帧的第一段
  文本前面补标记（已有标记不重复加，坏 JSON 原样放过），再交给原生 send。
  诊断出口：`window.__dshRoomMarkedCount`、`window.__dshRoomLastMarked`、
  `window.__dshRoomMarkPrompt(text)`。
- **验证**：单测覆盖标记注入/去重/放行；真页面里用一条真实 `session/prompt` 帧调用，
  `__dshRoomMarkedCount` 0 → 1，`lastMarked` 里能看到标记已插入。
- **未验证**：胶囊在会话里的实际渲染 —— 自动化点发送没能把消息真正发出去（Lexical
  编辑器 + 权限链路的自动化限制），需要房客手动发一条消息确认。

### 左下角账号区：整行换成房客身份，风格与 DSH 一致

- 以前是「把 DSH 账号区 `display:none`，再在页脚另挂一个自己的胶囊」，看着像贴上去的。
- 现在不打藏账号区，而是**住进 DSH 自己的账号按钮**（`[class*="settingsArea"] button`，
  那个「已登录 DeepSeek」行）：只留 DSH 原按钮当外框，行高 44px、内边距 6px、圆角 12px、
  字号 14px、颜色继承，全部跟着 DSH 走；里面换成「圆形头像首字 + 昵称」。
- 点击开「我的身份」面板（只改本机昵称/头像），不再弹房主账号菜单（已摘掉它的
  `aria-haspopup`）；侧栏折叠时与原版一致，只剩圆形头像。
- `tidyGuestSidebar()` 增加账号行模式：只藏该按钮内原有内容，不再扫兄弟节点（这条链一直
  通到侧栏根，扫错就是整页空白）；1.5 秒清理会把账号行整条链上的误标摘掉。
- 单测：账号行模式下原头像/原标签被藏、我们的按钮与容器不被藏。

## 0.1.14 — 2026-10-24

### 修掉「房客页整页空白，只剩左下角一颗按钮」的真因

- **真因（自伤）**：`tidyGuestSidebar()` 会藏掉页脚容器里的兄弟节点。侧栏折叠（或侧栏还没
  渲染完）时页脚是 0 尺寸，按钮按设计浮到 `body` 上，于是"兄弟节点"变成了 **`body` 的子级
  ——包括 `#root`**，被打上 `data-dsh-room-hidden="1"`，`[data-dsh-room-hidden]{display:none}`
  直接把整个应用藏掉。DSH 其实挂载得好好的（`#root.textContent` 里一应俱全、`#root` 计算样式
  `display:none`），所以看起来是"白屏"。
- **为什么时好时坏**：侧栏展开的浏览器 / 新房间一切正常；浏览器记住了侧栏折叠状态的老房间
  必现 —— 就是「曾经用过的路径进去什么都没有」。
- **修法**：① 按钮浮动（父节点是 `body`）时不再扫兄弟节点；② `hide()` 兜底，`#root` / `body`
  / 任何装着应用主体的节点一律不藏；③ 每 1.5 秒的清理顺带把误标在应用主体上的
  `data-dsh-room-hidden` 摘掉，页面能自己恢复。
- **保留白屏自救**（0.1.12 起）：7 秒没挂载 → 自动带 `?_r=` 重载一次；仍白屏 → 清掉 `dsh.*`
  界面状态再重载；再不行才浮「重新加载 / 清空本页数据并重载」。
- **新增 `test/probe-blank.mjs`**：CDP 诊断白屏（DOM 结构、命中 `#root` 的样式规则、
  localStorage、资源状态）。这次就是靠 `--rootcss` 看到 `[data-dsh-room-hidden="1"]` 命中
  `#root` 才定位的。
- 单测：浮动时不许把 `#root` 一级兄弟标成隐藏、误标要能自愈；假 DOM 补上 `[attr="值"]` 选择器。

## 0.1.13 — 2026-10-24

### 开发流程：改插件不再需要退出 DSH

- **发现**：DSH 0.2.1-rc.2 自带 `@deepseek-ai/dsh-hmr`（宿主）与 `@deepseek-ai/dsh-client-hmr`
  （浏览器），profile 上下文里默认以 `root: []` 启用 —— 只监听配置、不监听源码目录，
  但**每次重新组合都会替换 profile 目录下（含 `node_modules` 与已链接包目标）磁盘上
  已变化的插件**。所以改完 `index.mjs` 只要让它重新组合一次就生效，不需要重启。
- **实测**（本机，无 DSH 重启）：运行中的插件 version `0.1.11` → 改文件 + 写一次
  `cordis.patch.yml` → **2.1 秒后** `/room/api/host/state` 的 `version` 变成新值。
  重载会丢掉插件自身内存状态（房间需要重开），会话 / 工作区 / 模型上下文都在。
- **新增 `tools/watch-plugin.ps1`**：`FileSystemWatcher` 监听源码目录（跳过 `.git` /
  `node_modules` / `test` / `docs`），300 ms 防抖 + 2.5 s 冷却，变化后改写
  `cordis.patch.yml` 里的一行 `# hmr-probe <时间戳>` 触发重新组合；`-RoomPort 8787`
  会顺带确认插件真的换了（房间端口断开或版号变化）。`-Once` 只触发一次。
- **profile 里的插件改成目录联接**：`~/.dsh/profiles/desktop/node_modules/dsh-room`
  → `E:\E Download\AIWorking\dsh space\dsh-room`，写代码和 DSH 加载的是同一份文件，
  不再需要「改完复制过去」。旧的复制版备份在 `~/.dsh/backups/dsh-room-copy-20261024-151913`。
- 顺手修正：profile `cordis.patch.yml` 顶部「改完需要完全重启」那句注释已过时，改成
  「保存后约 2 秒由 HMR 重新组合」。

## 0.1.12 — 2026-10-24

### 白屏自愈：DSH 重启后房客浏览器拿着旧外壳时不再只能手动硬刷新

- **现象**：DSH 重启/升级后，房客浏览器里缓存的上一版网页外壳对不上新进程，整个界面
  不挂载 —— 只剩插件自己注入的那颗按钮，看起来像"页面坏了"。
- **代理层**：所有 `text/html` 响应强制 `cache-control: no-store, must-revalidate`
  并去掉 `etag` / `last-modified` / `expires`，房客每次拿到的都是当前版本的外壳
  （资源本身带 `rev` 指纹，会跟着换 URL）。
- **客户端自愈**：加载 7 秒后若界面仍没挂载（侧栏各块都是 0 尺寸、正文 < 40 字），
  先自动带 `?_r=<时间戳>` 重载一次（同一标签页只自动救一次，`sessionStorage` 记标记，
  不会死循环）；仍然空白则浮出「重新加载 / 清空本页数据并重载」两个按钮
  （后者清 localStorage + sessionStorage，不动登录 Cookie）。
- **诊断**：控制台一次性打印「房客页内容：N 字｜…」「被我们隐藏的元素：N 个｜最大 …」
  「nav 清单：…」，白屏时直接看这三行就能判断是外壳没挂载还是被我们藏掉了。
  WS 帧嗅探默认关闭，需要时 `localStorage.setItem('dsh-room.wsdebug','1')` 再刷新。

## 0.1.11 — 2026-10-24

### 左下角按钮「挂上了但看不见」的真凶；关标签页即退出；入口再收紧

- **房客身份按钮其实一直在，只是被 CSS 藏了**：`tidyGuestSidebar()` 会把 `footArea`
  的所有子级标记为隐藏，而按钮所在的 `footerActions` 正是其中一个子级 →
  `display:none` 之后按钮整块消失，日志里却照样写着「已挂进页脚」。现在任何
  **包含按钮本身**的元素一律跳过，并在日志里直接报 `按钮可见=是/否｜大标题=…｜页脚宽=N`。
- **侧栏收起时自动浮起**：页脚尺寸为 0（手机竖屏 / 侧栏折叠）时按钮改为浮在左下角，
  侧栏回来再挪回页脚，两个方向都自动。
- **关标签页 = 离开房间**：客户端在 `pagehide` / `beforeunload` 用 `navigator.sendBeacon`
  打 `/room/api/leave`；宿主侧另加 15 秒一次的清扫任务，房客超过 `MEMBER_TTL`
  （默认 120 秒，可用 `DSH_ROOM_MEMBER_TTL` 覆盖）没有动静就移出成员表并吊销令牌
  （再拿旧令牌打心跳会得到 401）。
- **访客不再「永远登录」**：DSH 发的登录 cookie 带很长的 `Max-Age`，代理转发时现在会
  **去掉 `Max-Age` / `Expires`**，落到房客浏览器上是会话 cookie —— 浏览器一关就没了，
  下次进来得重新加入房间。
- **左上角大标题留着但点不动**：只禁掉它的点击跳转（`pointer-events:none`），不再整块隐藏；
  「新建」入口、「添加工作区」、「视图选项」继续隐藏。
- **「用文件资源管理器打开」旁边的展开箭头也去掉了**：`[data-open-target] [class*="chevron"]`。
- 房客页自检日志（控制台一次）现在给每个剩余入口附上类名，例如
  `搜索会话 ⟨GAkraW_searchButton/GAkraW_search⟩`，方便一眼看出漏了谁。

## 0.1.10 — 2026-10-24

### 访客身份按钮改成「必定出现」，入口再砍一批

- **按钮以前可能根本不出现**：上一版注册在 React 插槽 `sidebar.footer.action` 上，
  房客页该插槽有时整块不渲染，于是左下角什么都没有。现在改成**纯 DOM 注入**：
  直接把按钮钉进侧栏的 `footerActions`，找不到就先浮在左下角，侧栏一出现再挪进去。
- **房客判定不再依赖 localStorage**：新增宿主接口 `GET /room/api/self`
  （房主直连 loopback → `host:true`，经房间代理进来的一律 `host:false`）；
  宿主还没重启、拿不到这个接口时，退回「我是不是从房间端口进来的」判断
  （房主在 DSH 的 web 端口，房客一定在房间端口，例如 8787）。
- **又砍掉这些入口**（房客页）：侧栏「全局面板」（插件/设置/技能…）、左上角大标题
  `brandIdentity`、标题下方的新建入口 `newSession`、工作区顶部的 `headerActions`
  （视图选项 + 添加工作区）、`账号菜单`、`用文件资源管理器打开`、`自动化任务`、
  `已归档管理`、`工作区"…"的操作`。实现分两层：CSS（按模块类名后缀匹配，
  DSH 换哈希前缀也命中）+ 按无障碍名匹配按钮。
- 控制台每次加载打一行「房客页剩余入口：…」，一眼看出还漏了哪个。

## 0.1.9 — 2026-10-24

### 房客页只剩工作区，左下角换成「我的身份」

- **入口精简**：房客页隐藏侧栏的「全局面板」列表（插件/设置/技能…）和页脚里的其它按钮，
  只留品牌、新会话、工作区树，以及一个新的「我的身份」按钮。用节点关系定位（从我们自己的
  按钮往上找两层），再叠一层 `[class*="panelList"]` / `[class*="settingsArea"]` 的 CSS 兜底，
  DSH 换哈希类名前缀也不会漏。
- **左下角不再是房主的账号**：房主账号/设置那块（点进去能改房主设置）在房客页整块隐藏，
  换成 `sidebar.footer.action` 插槽里的「我的身份」按钮（头像 + 昵称）。
- **点开只能改访客自己的昵称与头像**：6 行小面板，昵称输入框 + 8 个 emoji 头像，
  保存到本机 `localStorage`（`dsh-room.guest.profile.v1`），不碰房主账号、不改房间成员名。
  改完的昵称会用在会话里的身份标记上，房主和 agent 看到的就是这个名字。
- 宿主页完全不受影响：只有加入过房间（`dsh-room.guest` 存在）的页面才渲染这个按钮。

## 0.1.8 — 2026-10-24

### 拒绝要讲人话 · 权限要立刻生效 · 房客不许碰房主账号 · 房主消息也有头像

- **403 变成中文提示**：DSH 的 RPC 客户端只在 HTTP 2xx 时解析响应信封，非 2xx 直接抛
  `transport failure … HTTP 403`，所以房客以前只看到那句英文。现在代理把拒绝包装成
  `200 + {type:'server-response', result:{ok:false, error:{code:'room/readonly', message:'…'}}}`
  ——会话界面的 promptError 正好把 `error.message` 弹成 toast，房客看到的就是
  「当前是只读权限（房主设置），不能向 Agent 发送指令……（末尾附带 room/xxx 便于排查）」。
  拿不到 `rpcId` 的非 RPC 请求（如直接抓 `/api/file`）仍回 403 JSON。
- **权限改小立刻生效**：以前 `guard` 缓存了「会话 → 权限模式」，房主把可写改回只读后，
  房客不刷新页面还能继续发指令。现在只缓存「会话 → 工作区路径」，每次判定都按当前策略
  现算，升级/降级都不用对方刷新。
- **房客的禁区**：房客是借房主的登录态在操作，所以凡是改房主账号 / 全局设置 / 装插件 /
  跑任意代码 / 开宿主终端的端点，一律拒绝（`lib/guard.mjs` 的 `HOST_ONLY_ENDPOINTS`）：
  `account/*`（含退出登录）、`credentials/*`、`settings/*`、`pluginManager/*`、
  `pluginMarket/*`、`dynamicCordisRunner/*`、`terminal/*`、`directoryPicker/*`、
  `job/*`、`subagents/*`、`goals/*`、`schedule/*`、`llm/*`、`remoteAccess/*`、
  `cotTranslation/*`、`officeToPdf/*`、`userQuestions/*`、语音写入类、workspace 变更类、
  `session/initializeDefaultModel`、`agentPresets/select`。
- **读文件按路径现判**：`workspaceFiles/{list,read,readBytes,stat,changes}` 现在按目标路径
  判权限，封锁目录连读都不给（只读目录照常可读）。
- **房主自己的消息也有头像**：房主直连 DSH，请求不经过代理。改由客户端在发出
  `session/prompt` 前把 `〔@房主〕` 写进正文（房客页面写自己的名字），代理侧见到已有
  标记就跳过，两条路不会重复打标。

## 0.1.7 — 2026-10-24

### 修掉「会话里看不到身份胶囊」的真因：服务没等到就静默放弃了

0.1.6 在真机上没效果。原因：`uiConversation` 是会话插件**稍后**才提供的服务，
插件 `apply` 那一刻 `ctx.get('uiConversation')` 拿到的是 `undefined`，注册被
`try/catch` 静默吞掉——代码「成功」了，界面什么也没变。

- 改用官方写法等依赖：`ctx.inject(['uiConversation'], …)`；插槽条目也改走
  `ctx.slots.inject('conversation.user.text.node', …)`（与 `dsh-client-ui-skill`
  注册 `key: 'skill'` 的写法一致），另留有限次轮询兜底。
- **状态可见**：注册成功会往控制台打 `[dsh-room] 会话身份标记已启用…`；当前状态挂在
  `<html data-dsh-room-author>` 与联机按钮的 `data-author` 上
  （`ready / waiting-service / error / no-slots`），以后不用猜。
- 实机验证（客房页面 `http://172.16.1.130:8787/`，headless Chrome 抓 console）：
  `[dsh-room] 会话身份标记已启用：访客指令前会显示头像与昵称。`

## 0.1.6 — 2026-10-23

### 会话里也看得出「这条指令是谁发的」

DSH 的用户消息没有作者字段，房主和 agent 都只能看到一段光秃秃的文字。改法是让唯一知道
发话人的那一层（房间代理）把身份写进请求：

- **房客指令自动打标**（`lib/attribute.mjs`）：代理在转发 `POST /api/session/prompt` 时，
  把第一段文本改成 `〔@访客6105〕\n<原文>`；形状不认识、已经有标记、多段文本、附件段
  一律原样放行，绝不改坏请求。副作用是模型自己也看得到发话人，不会认错人。
- **客户端画成头像 + 昵称**（`lib/client.js` 的 `installAuthorChip`）：向 `uiConversation`
  注册一条 user-text 规则，把 `〔@名字〕` 切成独立节点 `room-author`，再用
  `conversation.user.text.node` 插槽把它渲染成「小头像 + 加粗昵称」的胶囊。
  规则 API 变了或插槽条目被拒时安静退回纯文本标记，界面不会坏。
- 房主自己的消息没有标记——「有标记 = 房客发的、带名字」，一眼区分。

## 0.1.5 — 2026-10-23

### 一眼看出「谁说的」+ 被拦下时说清「为什么」

- **消息头像更好认**：头像从 24px 一字改成 28px 两字、带身份色描边；默认名「访客6105」
  这类取尾部数字（`05`），不再所有访客都顶着一个「访」字。
- **昵称用身份色**：消息头里的昵称 12px 加粗，颜色按身份 id 取（同一人永远同色，
  同名不同人必不同色），悬停显示身份 id；配合 `房主 / 访客 / agent` 标签一眼分辨。
- **每条消息带 `data-identity`**：排查「这条是谁发的」时直接看属性。
- **被策略拦下时给人话**：新增 `lib/deny.mjs`，给每种拒绝配稳定 code + 中文说明；
  代理层回 `{ ok:false, error, code, message }`，客户端用一次 fetch 钩子（克隆响应、
  不改原响应）在屏幕下方弹出提示，例如
  「没有发送权限（只读）— 当前是只读权限（房主设置），不能向 Agent 发送指令……」。
  旧宿主只回枚举时，客户端也按枚举兜底翻译，不重启宿主也能看到提示。

## 0.1.4 — 2026-10-23

### 访客身份：谁说的分得清，AI 也分得清

- **访客身份稳定**：访客 id 由「名字 + 来源 IP」哈希得出（`g<8位>`），同一个人断线重连还是
  同一个 id（重连只换令牌，不换身份）。聊天记录里的「谁说的」在重连后依然对得上。
- **头像与配色按身份 id**：同一个 id 永远同一个颜色，同名的两个访客也一定是两种颜色；
  成员列表、消息头像都改用 id 取色（群头像仍按群名）。
- **消息带身份标签**：每条消息的名字后面有 `房主 / 访客 / agent` 标签，
  自己的消息靠 id 认（不是靠名字），agent 消息不再在名字后面拼 "· agent"。
- **系统提示**：有人进房 / 离房 / 被踢 / 掉线、agent 被拉进或移出群，都会在群里插一条
  居中的系统提示（`kind: 'system'`），不是人说的话，也不点亮未读红点。
- **新工具 `room_chat_members`**：给 agent 一张人员表——房主与每个访客的身份 id、进房时间、
  是否在线、最近谁说过话、每个群里有哪些 agent。
- **工具口径写死身份规则**：`room_chat_list / members / read / post` 的描述里都写明
  「同一个 id = 同一个人，不同 id = 不同的人；`fromId` 是说话人身份；`system` 是系统提示；
  回复要指名道姓」。`room_chat_read` 的返回新增 `fromId` 与 `mine`（这条是不是我自己发的）。

## 0.1.3 — 2026-10-23

### 交互：自绘下拉、选文件夹、面板可拖动

- 单选下拉不再用原生 `<select>`：改成「按钮 + fixed 浮层」的自绘组件（`Select`），
  选中项带勾、方向键 / `Enter` / `Esc` 全键盘可用，点外面收起，浮层不会被滚动容器裁切。
  房主工作区、工作区权限、新加文件夹权限三处全部换掉。
- 「单独开放某个文件夹」与「房主工作区」不再手输路径：桌面版点「选择文件夹…」直接弹
  系统目录选择框（`__DSH_DIRECTORY_PICKER__.pick()`，退回 `uiWorkspace.pickDirectory()`）；
  两者都拿不到时（纯浏览器）自动保留手输输入框作为兜底。
- 房间面板与聊天面板支持拖动：按住标题栏即可移动，拖动中禁用文本选择、不触发按钮，
  位置写入 `localStorage`（`dsh-room.pos` / `dsh-room.chatpos`），双击标题栏复位；
  手机端全屏浮层不参与拖动。
- 新增样式：`.dsh-room-sel*`（下拉）、`.dsh-room-pickrow/.dsh-room-pickpath`（选路径）、
  `.dsh-room-btn.sm`（行内小按钮）。
- 测试：client 冒烟新增「无原生 select」「下拉显示当前项 / 原始值兜底」「有选择器时不出现
  手输占位」「无选择器时保留兜底」「三个面板头都挂了指针事件」等断言；
  `test/render-preview.mjs` 增加下拉展开态与选择框样张。

## 0.1.2 — 2026-10-23

### 聊天改成右侧独立面板（外观 + 交互）

- 聊天不再是「房主 / 访客」之外的第三个标签：房间面板右上角新增聊天气泡入口，
  点开后在屏幕右侧展开横向长方形面板（`min(760px, 62vw) × min(452px, 56vh)`），宽大于高，不挡住主对话。
- 左列 198px 群列表（类似微信）：头像色块、群名、最后一条消息摘要、时间、未读数；
  选中行高亮；顶部是房间名与关闭按钮，底部是「+ 新建群」。
- 右列消息区：自己的消息靠右、带主色气泡；别人靠左；agent 消息带左侧高亮边和 `· agent` 标签；
  空态有提示文案；`Enter` 发送、`Shift+Enter` 换行。
- 房主在消息区右上角用 `agent` 按钮把工作区会话拉进当前群；非大厅群可一键删除（带确认）。
- 手机（宽度 < 560px）全屏显示，改成「群列表 → 消息」两级切换，左上角 `‹` 返回，`Esc` 逐级退出。
- 视觉全部复用 DSH 设计令牌（`--dsw-alias-*` / 圆角 / 阴影 / focus ring），
  并在 `prefers-reduced-motion` 下关闭动画；面板与聊天面板共用同一套 `--r-*` 变量。
- `test/render-preview.mjs` 增加聊天场景（房主 / 访客 / 深色 / 手机两级），
  新增 `preview/chat-panel-*.png` 预览图。

## 0.1.1 — 2026-10-23

### 房间聊天群（新）

- 面板新增第三个标签「聊天」；默认群「大厅」自动存在，房间内所有人都在里面，不可删除。
- 房主可新建 / 删除任意多个群；房主 + 全部房客天然属于每个群，无需入群操作。
- 房主可把**工作区里的会话（agent）**勾选进当前群；agent 只能读写自己被拉进的群。
- agent 侧新增工具：`room_chat_list` / `room_chat_read`（支持 `since` 增量）/ `room_chat_post`。
- 消息仅存内存（房间关闭即清空），全局单调 `seq` 供增量同步；
  面板 3 秒一轮拉取，房主操作与 agent 发言立刻可见。

### 修复：加载插件会让 DSH 直接崩溃

- 现象：`dsh: fatal load failure: TypeError: Cannot read properties of undefined (reading 'render')`，
  DSH 崩溃日志 `crash-*-host.log` 指向 `defineTool()`；整个桌面端起不来。
- 原因：`@deepseek-ai/dsh-tools` 的 `defineTool()` / `tools.register()` 强制要求
  工具定义带 `output: { schema, render }`，缺 `render` 立即抛错；**插件加载期的异常是致命的**。
- 修法：
  - 不再依赖 `defineTool()`，改为手写工具定义（`parameters` 用 DSH 支持的 JSON Schema 子集，
    `output.schema` 用 `{ type: 'object', additionalProperties: true }`，`output.render` 返回 text part）。
  - 整段注册包在 `try/catch` 里：任何一步失败只是「agent 看不到聊天群」，房间功能不受影响。
  - 新增 `test/schema.test.mjs`：直接调用 DSH 安装目录里**真实的**
    `assertSupportedJsonSchema` / `validateJsonSchemaValue` 校验我们注册的工具定义，
    把「DSH 会崩」这类问题挡在开发阶段（找不到 DSH 时打印 SKIP 退出）。
  - `test/host.test.mjs` 的假 `ctx.tools.register` 现在复刻 DSH 的硬校验，缺 `output.render` 直接抛。

### 修复：agent 选择器拿不到会话

- 房主页面里直接 `POST /api/session/list` 会撞 DSH 的令牌栅栏（`/api` 只认 cookie）。
- 新增房主专用接口 `GET /room/api/host/agents`：插件在宿主内部用启动令牌换一次
  `dsh-auth-*` cookie，再代问会话列表，返回 `{ ok, agents: [{ id, title }] }`；401 时自动换 cookie 重试一次。

## 0.1.0 — 2026-10-18

首个版本（私有开发版，未发布到 npm；发布计划暂缓）。

### 房间联机

- 房主在 DSH 里一键开房：选工作区、端口（默认 8787）、房间名，可选口令。
- 房客用**手机浏览器**直接打开 `http://<房主组网 IP>:8787/` 即可加入，
  不需要安装任何东西；代理自动完成 DSH 的登录握手（注入进程启动令牌）。
- 房客装了插件也可以从「联机 → 访客」主动加入，面板可复制邀请、看成员。
- HTTP 与 WebSocket 全透传；最近会话列表、消息流、工作台依次可见。

### 工作区权限（安全）

- 默认**封锁**所有工作区：房客看不到被封锁工作区的名称、路径和里面的对话。
- 房主可以按工作区/文件夹逐个开放，四种档位：
  - `blocked` 封锁（默认）
  - `readonly` 只读：只能看工作区与对话，**不能发消息、不能新建会话**
  - `write` 仅工作区内修改
  - `full` 完全权限
- 判定在代理层强制执行（HTTP 信封 + WebSocket 帧双向过滤），不认识的目标会话一律拒绝。
- 只读档位下 `session/prompt`、`session/create`、`session/cancel`、
  `session/rename`、`session/fork`、`session/selectModel`、`commands/execute`
  等写操作全部 403；终端 / 后台任务 / 工作流流直接不给房客开。
- 工具审批与「向用户提问」只回给房主：房客收到的审批请求被丢弃，回答入口
  `POST /api/$events/result` 对房客 403；切换权限预设、改全局设置同样 403。
- 房主覆盖权限预设（`read-only` / `workspace-write` / `danger-full-access`）
  按工作区档位钉住房客新建的会话。

### 稳定性

- 修复代理在响应头已发送后写头导致的 `ERR_HTTP_HEADERS_SENT` 致命崩溃：
  所有写出前检查 `headersSent` / `writableEnded`，代理回调异常自捕获。
- 修复改写压缩响应时残留 `content-encoding` 导致房客"看得到工作区、看不到对话"
  （浏览器报 `ERR_CONTENT_DECODING_FAILED`）。
- 浏览器里残留旧 DSH 进程的 `dsh-auth-*` cookie 时，页面加载返回 401
  "dsh web authentication required"，现在代理会用当前进程令牌自动重跳一次。

### 已知限制

- DSH 目前没有多租户 / 角色：房间成员在 DSH 眼里仍是 owner。
  本插件的封锁是**代理层**的强制，只覆盖走房间端口的访问。
- 房客首次打开工作台后拿到的 DSH cookie 不区分端口，停止房间不能撤销；
  彻底断开需要重启 DSH（令牌轮换）或把人移出组网。
