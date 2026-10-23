/**
 * 给房客发来的指令打上「谁说的」标记（纯逻辑，可离线单测）。
 *
 * 背景：DSH 会话里的用户消息没有作者字段，房主和 agent 只能看到一段光秃秃的文字，
 * 分不清是哪个访客发的。房间代理是唯一知道「这条请求是谁发的」的地方，所以在
 * 请求体里给第一段文本加上 `〔@访客6105〕` 前缀：
 *   · 房主在会话里立刻能看出是谁；
 *   · 模型自己也看得到发话人，回声/指代不会认错人；
 *   · 客户端（lib/client.js）注册一条 user-text 规则，把这个标记渲染成头像 + 昵称。
 * 前缀本身是纯文本，所以客户端没加载时也能退化成一个可读的「〔@访客6105〕」。
 */

const MARK_START = '〔@'
const MARK_END = '〕'

export function authorMarker(name) {
  const clean = String(name || '').replace(/[〔〕\r\n]/g, ' ').trim().slice(0, 40)
  return MARK_START + (clean || '访客') + MARK_END
}

export function hasAuthorMarker(text) {
  return String(text || '').trimStart().startsWith(MARK_START)
}

/** 从一段文本里读出标记里的名字（客户端渲染头像用）。 */
export function readAuthorMarker(text) {
  const match = /^〔@([^〕\n]{1,40})〕/.exec(String(text || ''))
  return match ? match[1] : ''
}

function firstTextPart(request) {
  const parts = request && request.content
  if (!Array.isArray(parts)) return null
  for (const part of parts) {
    if (part && part.type === 'text' && typeof part.text === 'string') return part
  }
  return null
}

/**
 * 改写一条 prompt 请求体，把作者标记加在第一段文本前面。
 * 任何一步对不上（形状变了、JSON 坏了、已经有标记）都原样返回，绝不把请求弄坏。
 *
 * @param {string} bodyText 原始请求体
 * @param {{ name?: string }} identity 发话的房客
 * @returns {string} 改写后的请求体（或原样）
 */
export function markPromptBody(bodyText, identity) {
  const name = identity && identity.name ? String(identity.name) : ''
  if (!name) return bodyText
  let payload
  try { payload = JSON.parse(bodyText) } catch { return bodyText }
  if (!payload || typeof payload !== 'object') return bodyText
  const args = payload.payload && payload.payload.args
  const request = (args && (args.request || args)) || null
  const part = firstTextPart(request)
  if (!part) return bodyText
  if (hasAuthorMarker(part.text)) return bodyText
  part.text = authorMarker(name) + '\n' + part.text
  try { return JSON.stringify(payload) } catch { return bodyText }
}
