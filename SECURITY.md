# 安全说明

`dsh-room` 把 DSH 工作台通过一个房间端口共享给同一组网内的成员。它的安全模型是
**"受信的组网 + 代理层强制的工作区权限"**，请先读清楚边界再决定开不开房。

## 威胁模型

- 能连上房间端口的人 = 组网内成员。组网本身（蒲公英 / ZeroTier / Tailscale）是第一道门。
- 房间口令只是**防误入**，不是加密，也不防同网络内的恶意成员。
- 房客在 DSH 眼里仍是 owner（DSH 0.2.x 没有多租户/角色）。本插件的封锁是
  **代理层**强制：它会过滤 HTTP 信封、WebSocket 帧和 `session/list` 响应，
  但**不改变 DSH 自身的授权判断**。
- 因此：如果你把 DSH 的 Web 端口直接暴露给房客（而不是只给房间端口），
  或者房客能直连 `127.0.0.1:<DSH 端口>`，代理层的限制会被绕过。

## 插件强制保证的事

1. 被封锁工作区的名称、路径、对话不会出现在房客的界面与 `session/list` 响应里。
2. 只读档位下，房客的写操作全部 403：
   `session/prompt`、`session/create`、`session/cancel`、`session/updateQueue`、
   `session/rename`、`session/fork`、`session/selectModel`、`commands/execute`。
3. 工具审批与「向用户提问」只回房主；房客回答审批入口 `POST /api/$events/result` 403。
4. 房客不能切权限（`/permission`、`settings.update ns=permission` 均 403）。
5. 房客不能发动宿主桌面操作（`session/openWorkspacePath`）或改全局设置。
6. 终端 / 后台任务 / 工作流等可写的 WebSocket 流不对房客开放。
7. 目标会话不在已知开放工作区内时，一律按拒绝处理（安全默认）。

## 插件**不能**保证的事

- 停止房间不会撤销已下发的 DSH 会话 Cookie（按主机名保存，不区分端口）。
  要彻底断开：停止房间 + 完全重启 DSH（进程令牌轮换），或把人移出组网。
- 「踢出」只删除房间成员记录，不是权限系统。
- 如果 DSH 上游未来把更多能力暴露成不需要代理经过的通道（例如插件自建端口），
  需要在那个通道上另做限制。

## 报告漏洞

请用 GitHub 的私下报告渠道（仓库 → Security → Report a vulnerability），
不要在公开 issue 里贴可利用细节。首个版本暂无 LTS 分支，修复会进 `main` 的新版本。
