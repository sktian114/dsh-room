# 1.0 之前的开发期，按 SemVer 预发布 / 小版本推进。

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
