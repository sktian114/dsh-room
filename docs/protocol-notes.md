# DSH 浏览器端协议笔记（dsh-room 代理过滤依据）

> 版本：DSH 0.2.1-rc.2。升级 DSH 后必须重新核对，帧协议变了守卫会静默失效。
> 证据来自解包代码 `@deepseek-ai/*` 与真实房客抓包（`test/probe-frames.mjs` 产物）。

## 传输

- 物理只有一条 WebSocket：`/api/remote.mux`，同源、**只认 Cookie**，不认 query token。
- 未启用 permessage-deflate（`WebSocketServer({ noServer: true })` 默认 false），帧是未压缩明文 JSON。
- 逻辑流按客户端生成的 `streamId` 复用。

### Client → Host 帧
| type | 字段 | 说明 |
| --- | --- | --- |
| `open` | `{type, streamId, endpoint, payload:{args}}` | payload 只允许 `args`；endpoint 为 `ns/method` 或 `$events` |
| `item` | `{type, streamId, value?}` | uplink 项，value 可缺省 |
| `end` | `{type, streamId}` | 半关闭 |
| `cancel` | `{type, streamId}` | 静默取消 |

### Host → Client 帧
| type | 字段 |
| --- | --- |
| `item` | `{type, streamId, value}` |
| `end` | `{type, streamId}` |
| `error` | `{type, streamId, error:{code,message,details}}` |

违规：重复 open → close 1008；二进制帧 → close 1003；非法 JSON → close 1008。

## HTTP 调用

- 路径 = `/api/<endpoint>`，**只接受 POST**；body 信封：
  `{"type":"client-request","rpcId":"<uuid>","method":"session/create","payload":{"args":{...}}}`
- 响应：`{"type":"server-response","rpcId":"<同 uuid>","result":{"ok":true,"value":...}}`。
- unary 只能 HTTP，stream 只能 WS，互走会被拒（`gateway/signature-invalid`）。
- 绕过 gateway 的精确路由：`GET /api/file?path=<绝对路径>`、`GET /connect`、`/plugins/...`、插件自己的 `/room/api/*`。

### 发消息不走 HTTP（0.2.1 实测，踩过）

`session/prompt`（也就是"发一条指令"）在前端是走 **WS mux** 的 `client-request` 帧：

```
{"type":"client-request","rpcId":"...","method":"session/prompt",
 "payload":{"args":{"request":{"requestId":"...","sessionId":"...","mode":"queue|steer",
                              "content":[{"type":"text","text":"..."}]}}}}
```

- 请求对象字段见 `@deepseek-ai/dsh-api-session-controller/lib/typert.remote-client.js`
  （`requestId` / `sessionId` / `mode` / `content` / 可选 `clientTimeZone`）。
- **没有** HTTP `/api/session/prompt` 这条路，也**不经过** `window.fetch` ——
  想改写用户消息内容（例如给房客指令加作者标记），唯一位置是
  `WebSocket.prototype.send`。
- 因此房客页的 `lib/client.js` 在 `send` 上改写 `session/prompt` 帧；代理那边只在
  历史遗留的 HTTP 路径上留了兜底。

## 会泄漏工作区/对话的端点

| 端点 | 帧/响应内容 | 泄漏字段 |
| --- | --- | --- |
| `workspace/follow`（WS） | baseline `{type,value:{items:[{workspaceId,path,title,sessionIds,...}]}}`；增量 `upsert/remove/order/archived/pinned/replace` | `path`、`title`、会话 id |
| `session/control`（WS） | baseline `{type,value:{projections:{<sessionId>:{asOfSeq,values}}}}`；增量 `{type:'projection',sessionId,key,value,seq}` | `title`、`workingDirectory`、`turnOutline`（提问与回答正文）、`permissions`、token 统计 |
| `session/follow`（WS） | 首帧 `snapshot{header:{cwd,...},records,projections}`，之后 `event` / `assistant-stream` | `header.cwd`、消息正文、工具参数（绝对路径） |
| `session/list`（HTTP unary） | `{items:[{sessionId,cwd,projections,...}]}` | `cwd` |
| `$events`（WS） | `ready{host:{home}}`、`waterfall{event,eventId,request}`、`emit` | `home`、审批/提问内容 |
| `GET /api/file?path=` | 文件内容 | 任意绝对路径 |

`workspaceId` 是创建时生成的稳定 UUID，**不是 path 派生**；只有 `workspace/follow` 能拿到 id 与 path 的对应关系。

## 审批

- 审批是 `$events` 上的 waterfall 事件 `approval/request`：`{type:'waterfall', event:'approval/request', eventId, agentId, request:{toolName,callId?,reason?,displayReason?}}`。
- 回答：`POST /api/$events/result`，args `{clientId, eventId, outcome}`，**要求 owner principal 且 interactions=answer**。
- 0.2.1-rc.2 没有非 owner 身份：浏览器连接一律 `principal={kind:'owner'}`，所以房客现在能收审批、也能点同意。
- 结论：想让"审批只走房主"，只能在代理层把 `approval/request` / `user-questions/request` 的 waterfall/emit 帧从房客流里删掉，并拒绝房客的 `POST /api/$events/result`。

## 权限预设

- 沙箱枚举：`read-only` / `workspace-write` / `danger-full-access`；审批策略：`ask` / `never`。
- 内置预设：`workspace-write`（默认）、`danger-full-access`；另有保留 `auto`；派生 `custom` 不可选。
- `session/create` **没有**权限预设字段；新会话取 settings `permission.defaultPreset`。
- 运行中切换：`POST /api/commands/execute`，args `{agentId, line:"/permission <preset>", submittedAttachments:[]}`。
- 因此"只读/仅工作区可写/完全权限"的强制落点：拦截房客 `session/create` 后，由代理以房主身份对该 sessionId 执行 `/permission <preset>`；只读档位需要 DSH 侧支持（内置没有 read-only 预设，需复核）。

## 代理改写响应的坑（实测踩过）

- DSH 会对 API 响应做 gzip/br 压缩。代理若**缓冲并改写**响应体，必须同时：
  1. 请求上游时删掉 ccept-encoding（让它回明文）；
  2. 写回时删掉 content-encoding / content-length，并把 content-type 设为 pplication/json; charset=utf-8。
- 否则浏览器拿到"明文 body + gzip 头"会报 ERR_CONTENT_DECODING_FAILED：页面不崩，但**会话列表/工作区对话会整块消失**（session/list 请求失败），工作区名字却还在——非常难猜，务必按上面的做法处理。
- 所有 es.writeHead 前都要判 !res.headersSent && !res.writableEnded；代理回调里的任何异常都要自己 catch，否则会成为宿主的 uncaught exception（DSH 会直接 fatal 退出）。

## 注册 agent 工具：少一个 `output.render` 就炸掉整个 DSH（2026-10-23 实测）

- DSH 的 `tools.register(definition)` 只接受这种形状：
  `{ name, description, parameters(<JSON Schema>), output: { schema, render, presentationMeta? }, execute }`。
  `output` 缺失、或 `output.render` 不是函数 → **TypeError**；而**插件加载期的异常是致命的**，
  DSH 会直接 `fatal load failure` 退出（桌面端表现为“崩溃，必须重启”）。
- `@deepseek-ai/dsh-tools` 的 `defineTool()` 同样在函数体第一行读 `options.output.render`，
  所以用 `defineTool({...})` 时**也必须**写 `output.schema` + `output.render`，不能只写 `parameters` + `execute`。
- schema 只能落在 DSH 支持的子集：`type / oneOf / properties / required / additionalProperties / items / enum / const`
  + 注释字段（`description` / `title`）。`type` 允许
  `string|number|integer|boolean|null|array|object|json`；`type` 与 `oneOf` 不能同时出现。
  最省事的输出 schema：`{ type: 'object', additionalProperties: true }`，配
  `render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]`。
- 结论：**工具注册必须整段 try/catch**，并且要有开关（本项目用 `config.chatTools === false` 或 `DSH_ROOM_CHAT_TOOLS=0`）。
  `test/schema.test.mjs` 会直接调用 DSH 安装目录里真实的 `assertSupportedJsonSchema` /
  `validateJsonSchemaValue` 校验工具定义，把这类崩溃挡在开发阶段。

## 房主侧代问 DSH 内部接口要带 cookie，光有启动令牌不够

- `?token=<启动令牌>` 只能用于**根页面**：DSH 用它换一次 `dsh-auth-*` cookie（303 + Set-Cookie）。
  直接 `POST /api/session/list?token=...` 仍然 401。
- 插件要在宿主内部读会话列表，正确姿势是：
  1. `GET /?token=<launchToken>`（Host 头写 `127.0.0.1:<port>`），抓 `set-cookie` 里的 `dsh-auth-*`；
  2. 带 `cookie` 头 `POST /api/session/list`，信封
     `{ type:'client-request', rpcId, method:'session/list', payload:{ args:{ _request:{} } } }`；
  3. 401/403 就丢掉缓存 cookie、重新换一次再试。
- 这样房主面板的「agent 选择器」不用依赖浏览器 cookie，也不用把 `/api/*` 暴露给房客。