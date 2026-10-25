/**
 * WebSocket 文本帧的最小解析/重组，用于房间代理做帧级过滤。
 *
 * 只处理「FIN=1 的文本帧」，其余（二进制、分片、Ping/Pong/Close）原样透传；
 * DSH 的 RPC 帧都是单帧明文 JSON（permessage-deflate 未启用，见 docs/protocol-notes.md），
 * 一旦升级后行为变化，这里应当整段透传而不是改坏流量。
 */

function encodeFrame(fin, opcode, payload, masked) {
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
    const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
    mask.copy(out, offset)
    offset += 4
    for (let i = 0; i < length; i += 1) out[offset + i] = payload[i] ^ mask[i & 3]
  } else {
    payload.copy(out, offset)
  }
  return out
}

/**
 * @param {object} options
 * @param {boolean} options.masked 客户端→服务端需要重新加掩码
 * @param {(text: string) => string|null|undefined} options.onText
 *   返回 null 表示丢弃该帧；返回字符串表示替换；undefined 表示原样。
 */
export function createFrameTransformer(options) {
  const masked = Boolean(options.masked)
  const onText = options.onText
  // 单帧上限：RPC 的 mux 帧都是单帧、尺寸很小；声明一个天文数字（127 分支可到 2^63）
  // 就能让 buffer 只增不减，把宿主内存吃干净（2026-10-25 审计）。
  const MAX_FRAME = Math.max(64 * 1024, Number(options.maxFrame) || 2 * 1024 * 1024)
  const MAX_BUFFER = MAX_FRAME * 2
  let buffer = Buffer.alloc(0)
  return {
    push(chunk) {
      if (!chunk || !chunk.length) return Buffer.alloc(0)
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk)
      if (buffer.length > MAX_BUFFER) {
        // 攒了超过两帧还没解出来：要么是分片帧、要么是恶意负载，直接放弃这条连接
        buffer = Buffer.alloc(0)
        throw new Error('frame-buffer-overflow')
      }
      const out = []
      while (buffer.length >= 2) {
        const b0 = buffer[0]
        const b1 = buffer[1]
        const fin = (b0 & 0x80) !== 0
        const opcode = b0 & 0x0f
        const isMasked = (b1 & 0x80) !== 0
        let length = b1 & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) break
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) break
          length = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }
        if (!Number.isFinite(length) || length < 0 || length > MAX_FRAME) {
          buffer = Buffer.alloc(0)
          throw new Error('frame-too-large')
        }
        let mask = null
        if (isMasked) {
          if (buffer.length < offset + 4) break
          mask = buffer.slice(offset, offset + 4)
          offset += 4
        }
        if (buffer.length < offset + length) break
        const payload = Buffer.from(buffer.slice(offset, offset + length))
        buffer = buffer.slice(offset + length)
        if (mask) {
          for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3]
        }
        let replace
        if (opcode === 0x1 && fin) {
          const text = payload.toString('utf8')
          try { replace = onText(text) } catch { replace = undefined }
          if (replace === null) continue
        }
        const body = typeof replace === 'string' ? Buffer.from(replace, 'utf8') : payload
        out.push(encodeFrame(fin, opcode, body, masked))
      }
      return Buffer.concat(out)
    },
  }
}
