# 1.0 之前的开发期，按 SemVer 预发布 / 小版本推进。

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
