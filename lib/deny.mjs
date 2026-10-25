/**
 * 「房客撞墙」时的拒绝说明（纯数据，可离线单测）。
 *
 * 为什么单独一个文件：房客被拦下时，浏览器原本只会显示 DSH 的默认报错，
 * 房客分不清是「自己没权限」还是「房间坏了」。这里给每种拒绝配一个稳定 code
 * + 一句人话，代理层照它回 JSON，客户端（lib/client.js 的 DENY_TITLES /
 * installDenyNotice）照 code 弹提示。新增拒绝理由时两边都要加，测试会互相对账。
 */

export const DENY_REASONS = {
  'workspace-readonly': {
    code: 'room/readonly',
    message: '当前是只读权限（房主设置），不能向 Agent 发送指令。你可以浏览会话、查看共享目录里的文件；需要动手改东西，请房主把你的权限改成「仅工作区可写」。',
  },
  'workspace-blocked': {
    code: 'room/blocked',
    message: '这个目录房主没有开放给房客，操作已经被拦下。需要的话请房主在房间面板里开放该目录。',
  },
  'permission-locked': {
    code: 'room/permission-locked',
    message: '房客不能自己改权限，权限统一由房主在房间里设置。',
  },
  'host-only': {
    code: 'room/host-only',
    message: '这个操作只能在房主自己的电脑上执行。',
  },
  'approval-owner-only': {
    code: 'room/approval-owner-only',
    message: '审批只能由房主回答，房客看不到、也答不了。',
  },
  'payload-too-large': {
    code: 'room/payload-too-large',
    message: '这次请求的内容太大，房间代理拒绝了它。请减少附件或分批发送。',
  },
}

/** 统一的拒绝体：error 保留原枚举（老客户端/测试靠它），code + message 给人看。 */
export function denyBody(reason) {
  const key = String(reason || '')
  // 不能用 DENY_REASONS[key] 直接取：`__proto__` / `constructor` 这类键会命中原型链，
  // 拿到 undefined 或函数，JSON 里 code/message 直接消失（审计发现的潜在坑）。
  const known = Object.prototype.hasOwnProperty.call(DENY_REASONS, key) ? DENY_REASONS[key] : null
  return {
    ok: false,
    error: key,
    code: known ? known.code : 'room/' + key,
    message: known ? known.message : '这个操作被房间策略拦下了（' + key + '）。',
  }
}
