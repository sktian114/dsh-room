/**
 * 真机验收：胶囊「只做原地样式、不搬节点」（0.3.14）
 * 用户两次反馈：胶囊有时和底部悬浮输入区并排堆在最下方、永不消失。
 * 根因是提升逻辑把 .dsh-room-authorline 插成了 [data-conversation-scroll]（display:flex）的
 * 第三个 flex 子项；现在不再插入任何节点。
 *
 * 检查项：
 *  ① 带标记的正文会长出胶囊，且胶囊留在正文容器里（不在任何 .dsh-room-authorline 里）
 *  ② 不再产生 .dsh-room-authorline
 *  ③ 旧版本残留的行会被清掉、被藏起来的胶囊会复原可见
 *  ④ 连跑多轮不堆积
 *
 * 用法：node test/probe-run.mjs --url=http://127.0.0.1:8787/ --wait=10000 \
 *        --js=test/probe-chipline-inplace.js --port=9470
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = {}
  const paint = () => { if (typeof window.__dshRoomPaintAuthors === 'function') window.__dshRoomPaintAuthors() }
  try {
    out.hasPaintHook = typeof window.__dshRoomPaintAuthors === 'function'
    await sleep(2500)

    // ① 造一条消息：list → row → bubble → text（和真实会话同构）
    const list = document.createElement('div')
    const row = document.createElement('div')
    const bubble = document.createElement('div')
    const text = document.createElement('div')
    text.appendChild(document.createTextNode('〔@访客A〕你好呀'))
    bubble.appendChild(text)
    row.appendChild(bubble)
    list.appendChild(row)
    document.body.appendChild(list)

    const linesBefore = document.querySelectorAll('.dsh-room-authorline').length
    paint()
    await sleep(300)
    const chip = text.querySelector('.dsh-room-author')
    out.chipCreated = Boolean(chip)
    out.chipText = chip ? String(chip.textContent || '').trim() : null
    out.chipStaysInBubble = Boolean(chip && bubble.contains(chip))
    out.chipVisible = Boolean(chip && chip.style.display !== 'none')
    out.newLines = document.querySelectorAll('.dsh-room-authorline').length - linesBefore
    out.noLineCreated = out.newLines <= 0
    out.msgTextKept = String(bubble.textContent || '').indexOf('你好呀') >= 0

    // ② 旧版本残留：一条孤儿行 + 一个被藏起来的占位
    const stray = document.createElement('div')
    stray.className = 'dsh-room-authorline'
    stray.setAttribute('data-dsh-room-authorline', '1')
    stray.setAttribute('data-dsh-room-linefor', 'legacy1')
    stray.appendChild(document.createTextNode('残留胶囊'))
    list.appendChild(stray)
    if (chip) {
      chip.setAttribute('data-dsh-room-chipstub', 'legacy1')
      chip.style.display = 'none'
    }
    out.legacyBefore = document.querySelectorAll('.dsh-room-authorline').length
    paint()
    await sleep(300)
    out.legacyLineGone = !document.querySelector('.dsh-room-authorline[data-dsh-room-linefor="legacy1"]')
    out.legacyStubRestored = Boolean(chip && chip.style.display !== 'none' && !chip.getAttribute('data-dsh-room-chipstub'))

    // ④ 旧格式兜底不许把正文里的 @点名 当成发送者
    const legacyRow = document.createElement('div')
    const legacyText = document.createElement('div')
    legacyText.appendChild(document.createTextNode('〔@房主〕【房间消息·agent聊天室】@总监 胶囊位置回归测试：这条是正文'))
    legacyRow.appendChild(legacyText)
    list.appendChild(legacyRow)
    paint()
    await sleep(300)
    const legacyChips = [...legacyRow.querySelectorAll('.dsh-room-author')]
    out.legacyChipCount = legacyChips.length
    out.legacyChipLabels = legacyChips.map((el) => String(el.textContent || '').trim().slice(0, 24))
    out.noMentionSwallowed = !legacyChips.some((el) => String(el.textContent || '').indexOf('总监') >= 0)
    out.bodyTextKept = String(legacyRow.textContent || '').indexOf('@总监 胶囊位置回归测试：这条是正文') >= 0

    // ⑤ 连跑多轮：数量稳定、不堆积
    paint(); paint(); paint()
    await sleep(400)
    out.linesAfterRuns = document.querySelectorAll('.dsh-room-authorline').length
    out.chipsAfterRuns = document.querySelectorAll('.dsh-room-author').length
    out.stable = out.linesAfterRuns === 0 && out.chipsAfterRuns === 2   // 两条消息各一个胶囊

    list.remove()
  } catch (error) {
    out.error = String(error && error.message ? error.message : error)
  }
  return JSON.stringify(out, null, 2)
})()
