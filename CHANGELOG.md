# 1.0 之前的开发期，按 SemVer 预发布 / 小版本推进。

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
