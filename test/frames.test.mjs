/**
 * 帧解析的回归测试（2026-10-25 发布前审计 B1）：
 * 分片帧（FIN=0）与孤立的续帧（opcode 0x0）必须被拒绝，
 * 否则 `open` 帧被拆片后帧级过滤看不到 endpoint，服务端帧就会被无条件放行
 * —— 等于绕过「访客不能碰宿主终端」那道唯一防线。
 */

import assert from 'node:assert/strict'
import { createFrameTransformer } from '../lib/frames.mjs'

function frame({ fin = true, opcode = 0x1, payload = Buffer.alloc(0), masked = true }) {
  const length = payload.length
  let headerLength = 2 + (masked ? 4 : 0)
  if (length >= 65536) headerLength += 8
  else if (length >= 126) headerLength += 2
  const out = Buffer.alloc(headerLength + length)
  out[0] = (fin ? 0x80 : 0) | opcode
  let offset = 2
  if (length >= 65536) {
    out[1] = 127
    out.writeBigUInt64BE(BigInt(length), 2)
    offset = 10
  } else if (length >= 126) {
    out[1] = 126
    out.writeUInt16BE(length, 2)
    offset = 4
  } else {
    out[1] = length
  }
  if (masked) {
    out[1] |= 0x80
    const mask = Buffer.from([0x01, 0x02, 0x03, 0x04])
    mask.copy(out, offset)
    offset += 4
    for (let i = 0; i < length; i += 1) out[offset + i] = payload[i] ^ mask[i & 3]
  } else {
    payload.copy(out, offset)
  }
  return out
}

const seen = []
const tx = createFrameTransformer({
  masked: false,
  onText: (text) => { seen.push(text); return undefined },
})

// 1. 普通单帧文本帧：照常解析给 onText
const ok = tx.push(frame({ payload: Buffer.from('{"type":"open"}', 'utf8'), masked: true }))
assert.ok(ok.length > 0, '单帧文本帧应当透传')
assert.deepEqual(seen, ['{"type":"open"}'], 'onText 应当看到完整文本')

// 2. 分片帧（FIN=0）必须抛错 —— 这是 0.3.16 新增的拦截
const tx2 = createFrameTransformer({ masked: false, onText: () => undefined })
assert.throws(
  () => tx2.push(frame({ fin: false, payload: Buffer.from('{"type":"op', 'utf8'), masked: true })),
  /fragmented-frame/,
  '分片帧必须被拒绝（否则 open 帧可绕开帧级过滤）',
)

// 3. 孤立续帧（opcode 0x0）也必须拒绝
const tx3 = createFrameTransformer({ masked: false, onText: () => undefined })
assert.throws(
  () => tx3.push(frame({ opcode: 0x0, payload: Buffer.from('"en"}', 'utf8'), masked: true })),
  /orphan-continuation/,
  '续帧不能单独出现',
)

// 4. 二进制帧仍然原样透传（分片只拦文本流，别把普通数据帧也挡掉）
const tx4 = createFrameTransformer({ masked: false, onText: () => undefined })
const bin = tx4.push(frame({ opcode: 0x2, payload: Buffer.from([1, 2, 3]), masked: true }))
assert.ok(bin.length > 0, '二进制帧要透传')

// 5. 超过单帧上限的声明长度要抛 frame-too-large（0.3.11 的行为保持不变）
const tx5 = createFrameTransformer({ masked: false, onText: () => undefined, maxFrame: 64 * 1024 })
const huge = Buffer.alloc(16)
huge[0] = 0x81
huge[1] = 0x7f
huge.writeBigUInt64BE(BigInt(64 * 1024 * 1024), 2)
assert.throws(() => tx5.push(huge), /frame-too-large/, '超限帧要拒绝')

console.log('dsh-room frames test: PASS')
