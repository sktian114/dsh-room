/**
 * 「谁发的指令」标记的单测：跑 `node test/attribute.test.mjs`。
 *
 * 房客的 prompt 会被房间代理加上 `〔@访客6105〕` 前缀——这条前缀同时承担三件事：
 * 房主在会话里看得见、模型看得见、客户端把它渲染成头像 + 昵称。
 * 所以这里既要验证「正常请求会被打标」，也要验证「形状不认识时一个字节都不改」。
 */
import assert from 'node:assert/strict'
import { authorMarker, hasAuthorMarker, readAuthorMarker, markPromptBody } from '../lib/attribute.mjs'

/* ── 1. 标记本体 ── */
assert.equal(authorMarker('访客6105'), '〔@访客6105〕')
assert.equal(authorMarker('  阿 伟  '), '〔@阿 伟〕')
assert.equal(authorMarker(''), '〔@访客〕')
assert.equal(authorMarker('坏〕名字\n换行'), '〔@坏 名字 换行〕', '标记里不能出现会破坏解析的字符')
assert.equal(hasAuthorMarker('〔@阿伟〕\n你好'), true)
assert.equal(hasAuthorMarker('你好'), false)
assert.equal(readAuthorMarker('〔@阿伟〕\n你好'), '阿伟')
assert.equal(readAuthorMarker('你好'), '')

/* ── 2. 正常 prompt：第一段文本被前缀，结构不变 ── */
const promptBody = JSON.stringify({
  type: 'client-request',
  rpcId: 'r-1',
  method: 'session/prompt',
  payload: {
    args: {
      request: {
        requestId: 'req-1',
        sessionId: 's1',
        mode: 'queue',
        content: [{ type: 'text', text: '帮我改一下标题' }],
      },
    },
  },
})
const marked = markPromptBody(promptBody, { name: '访客6105' })
const parsed = JSON.parse(marked)
assert.equal(parsed.payload.args.request.content[0].text, '〔@访客6105〕\n帮我改一下标题')
assert.equal(parsed.payload.args.request.sessionId, 's1', '其它字段原样保留')
assert.equal(parsed.rpcId, 'r-1')
assert.equal(parsed.method, 'session/prompt')

/* ── 3. 幂等：已经打过标就不再叠加 ── */
assert.equal(markPromptBody(marked, { name: '访客6105' }), marked)

/* ── 4. 多段文本只标第一段，附件段不动 ── */
const multi = JSON.stringify({
  payload: { args: { request: { content: [
    { type: 'text', text: '看图' },
    { type: 'image', mediaType: 'image/png', data: 'AAAA' },
    { type: 'text', text: '谢谢' },
  ] } } },
})
const multiMarked = JSON.parse(markPromptBody(multi, { name: '小鹿' }))
assert.equal(multiMarked.payload.args.request.content[0].text, '〔@小鹿〕\n看图')
assert.equal(multiMarked.payload.args.request.content[1].type, 'image')
assert.equal(multiMarked.payload.args.request.content[2].text, '谢谢')

/* ── 5. 认不出来的形状一律原样返回（宁可少标，也不能把请求弄坏） ── */
const untouched = [
  'not json at all',
  JSON.stringify({ foo: 'bar' }),
  JSON.stringify({ payload: { args: {} } }),
  JSON.stringify({ payload: { args: { request: { content: [] } } } }),
  JSON.stringify({ payload: { args: { request: { content: [{ type: 'image' }] } } } }),
]
for (const body of untouched) {
  assert.equal(markPromptBody(body, { name: '阿伟' }), body)
}
assert.equal(markPromptBody(promptBody, {}), promptBody, '没有身份就不打标')
assert.equal(markPromptBody(promptBody, null), promptBody)

console.log('dsh-room attribute test: PASS')
