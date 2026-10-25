/**
 * 端到端验收：真实推送消息在会话历史里渲染后，「谁发的」胶囊的位置。
 * 做法：打开侧栏里标题含「总监」的会话（刚被探针点名推送过一条），滚到底，
 * 数一数胶囊行、量一量胶囊和底部悬浮输入区（composerSeat）的位置关系。
 *
 * 用法：node test/probe-run.mjs --url=http://127.0.0.1:8787/ --url2=http://127.0.0.1:56155/ \
 *        --wait=7000 --wait2=12000 --js=test/probe-chip-e2e-session.js --port=9482
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = {}
  const rectOf = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const click = (el) => {
    const r = el.getBoundingClientRect()
    const init = { bubbles: true, cancelable: true, clientX: r.x + 5, clientY: r.y + 5, button: 0 }
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, init))
    }
  }
  try {
    await sleep(2500)
    // 侧栏里找标题含「总监」的那一行
    const rows = [...document.querySelectorAll('[class]')].filter((el) => {
      const text = String(el.textContent || '').trim()
      if (!text.startsWith('总监')) return false
      if (text.length > 20) return false
      const r = el.getBoundingClientRect()
      return r.width > 40 && r.height > 10 && r.height < 200
    }).sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)
    out.foundRow = rows.length
    if (rows[0]) click(rows[0])
    await sleep(5000)

    // 滚到最底（最新消息）
    const scroller = document.querySelector('[data-conversation-scroll]')
    out.hasScroller = Boolean(scroller)
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight
      await sleep(1200)
      scroller.scrollTop = scroller.scrollHeight
      await sleep(1500)
    }
    if (typeof window.__dshRoomPaintAuthors === 'function') window.__dshRoomPaintAuthors()
    await sleep(600)

    const chips = [...document.querySelectorAll('.dsh-room-author')]
    const lines = [...document.querySelectorAll('.dsh-room-authorline')]
    out.chipCount = chips.length
    out.lineCount = lines.length
    out.chips = chips.slice(0, 4).map((chip) => {
      const rect = rectOf(chip)
      let inScrollBody = false
      let depth = 0
      let cur = chip.parentElement
      while (cur && depth < 20) {
        if (cur.hasAttribute && cur.hasAttribute('data-conversation-scroll')) inScrollBody = true
        cur = cur.parentElement
        depth += 1
      }
      return {
        text: String(chip.textContent || '').trim().slice(0, 16),
        stub: Boolean(chip.getAttribute('data-dsh-room-chipstub')),
        hidden: chip.style.display === 'none',
        rect,
        inScrollBody,
      }
    })
    // 底部悬浮输入区
    const seat = document.querySelector('[data-composer-seat], .an3WzG_composerSeat')
    out.composerSeat = rectOf(seat)
    // 胶囊离悬浮区太近（< 20px）就是"和悬浮行挤在一起"
    out.chipsNearComposer = out.chips.filter((chip) => {
      if (!chip.rect || !out.composerSeat) return false
      return Math.abs(chip.rect.y - out.composerSeat.y) < 20
    }).length

    // 历史里到底有没有渲染出推送消息（含标记）
    const bodyText = String(document.body.innerText || '')
    out.markerVisible = /〔@/.test(bodyText)
    out.pushTextVisible = /胶囊位置回归测试|房间消息/.test(bodyText)
    out.aroundPush = (() => {
      const at = bodyText.indexOf('胶囊位置回归测试')
      return at < 0 ? null : bodyText.slice(Math.max(0, at - 60), at + 40)
    })()
  } catch (error) {
    out.error = String(error && error.message ? error.message : error)
  }
  return JSON.stringify(out, null, 2)
})()
