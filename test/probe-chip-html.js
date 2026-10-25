/**
 * 只读：把真实推送消息里的胶囊连同 HTML 打出来（带重试，历史是虚拟列表，渲染有延迟）。
 * 用法：node test/probe-run.mjs --url=http://127.0.0.1:8787/ --url2=http://127.0.0.1:56155/ \
 *        --wait=7000 --wait2=13000 --js=test/probe-chip-html.js --port=9484
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = { chips: [], tries: 0 }
  const click = (el) => {
    const r = el.getBoundingClientRect()
    const init = { bubbles: true, cancelable: true, clientX: r.x + 5, clientY: r.y + 5, button: 0 }
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, init))
  }
  const paint = () => { if (typeof window.__dshRoomPaintAuthors === 'function') window.__dshRoomPaintAuthors() }
  try {
    await sleep(2000)
    const row = [...document.querySelectorAll('[class]')].filter((el) => {
      const text = String(el.textContent || '').trim()
      if (!text.startsWith('总监')) return false
      if (text.length > 20) return false
      const r = el.getBoundingClientRect()
      return r.width > 40 && r.height > 10 && r.height < 200
    }).sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)[0]
    if (row) click(row)
    out.foundRow = Boolean(row)
    await sleep(4500)

    const scroller = document.querySelector('[data-conversation-scroll]')
    out.hasScroller = Boolean(scroller)
    for (let i = 0; i < 6; i += 1) {
      out.tries = i + 1
      if (scroller) {
        // 从上往下逐段推，逼虚拟列表把新消息渲染出来
        scroller.scrollTop = scroller.scrollHeight
        await sleep(700)
      }
      paint()
      await sleep(400)
      if (document.querySelectorAll('.dsh-room-author').length) break
    }
    out.chips = [...document.querySelectorAll('.dsh-room-author')].slice(0, 5).map((chip) => {
      const r = chip.getBoundingClientRect()
      return {
        html: String(chip.outerHTML || '').slice(0, 460),
        parentCls: chip.parentElement ? String(chip.parentElement.className || '').slice(0, 40) : '',
        nextText: chip.nextSibling ? String(chip.nextSibling.textContent || '').slice(0, 40) : null,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) },
      }
    })
    out.lineCount = document.querySelectorAll('.dsh-room-authorline').length
    const bodyText = String(document.body.innerText || '')
    out.pushTextVisible = /胶囊位置回归测试/.test(bodyText)
    out.rawMarkerLeft = /〔@/.test(bodyText)
    out.aroundPush = (() => {
      const at = bodyText.indexOf('胶囊位置回归测试')
      return at < 0 ? null : bodyText.slice(Math.max(0, at - 40), at + 60)
    })()
  } catch (error) {
    out.error = String(error && error.message ? error.message : error)
  }
  return JSON.stringify(out, null, 2)
})()
