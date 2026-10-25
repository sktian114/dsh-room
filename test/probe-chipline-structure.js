/**
 * 诊断：真实会话里胶囊/胶囊行到底挂在哪、为什么会被挤到最下面。
 * 只读，不改任何东西。输出：每个 .dsh-room-author 的祖先链（含 display/overflow/rect），
 * 以及每个 .dsh-room-authorline 的位置与父级。
 *
 * 用法：node test/probe-run.mjs --url=http://127.0.0.1:8787/ --wait=9000 \
 *        --js=test/probe-chipline-structure.js --port=9460
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = { sessions: [], chips: [], lines: [] }
  const info = (el) => {
    if (!el || el.nodeType !== 1) return null
    const rect = el.getBoundingClientRect()
    let style = null
    try { style = window.getComputedStyle(el) } catch (e) { style = null }
    const cls = String(el.className || "").slice(0, 60)
    return {
      tag: el.tagName,
      cls: cls,
      id: el.id || "",
      display: style ? style.display : "",
      overflowY: style ? style.overflowY : "",
      position: style ? style.position : "",
      y: Math.round(rect.y), h: Math.round(rect.height), w: Math.round(rect.width),
    }
  }
  const chain = (el, depth) => {
    const list = []
    let cur = el
    let n = 0
    while (cur && cur.nodeType === 1 && n < depth) {
      list.push(info(cur))
      cur = cur.parentElement
      n += 1
    }
    return list
  }
  try {
    await sleep(3500)

    // 打开「总监」这条会话（里面有很多 【房间消息·…】 推送，胶囊最密集）
    const pick = (name) => [...document.querySelectorAll("[class]")]
      .filter((el) => {
        const text = String(el.textContent || "").trim()
        if (text !== name) return false
        if (el.children.length > 3) return false
        const rect = el.getBoundingClientRect()
        return rect.width > 20 && rect.height > 8
      })
      .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0]
    const target = pick("总监") || pick("插件-聊天室之主")
    out.sessions = target ? [String(target.textContent || "").trim()] : []
    if (target) {
      const rect = target.getBoundingClientRect()
      const init = { bubbles: true, cancelable: true, clientX: rect.x + 5, clientY: rect.y + 5, button: 0 }
      for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
        target.dispatchEvent(new MouseEvent(type, init))
      }
      out.clicked = out.sessions[0]
      await sleep(5000)
    }

    // 滚到底，逼历史里带标记的消息都渲染出来
    const scrollers = [...document.querySelectorAll("div")].filter((el) => {
      try {
        const s = window.getComputedStyle(el)
        return (s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 40
      } catch (e) { return false }
    })
    out.scrollerCount = scrollers.length
    if (scrollers[0]) {
      scrollers[0].scrollTop = 0
      await sleep(1200)
      scrollers[0].scrollTop = scrollers[0].scrollHeight
      await sleep(1500)
    }
    if (typeof window.__dshRoomPaintAuthors === "function") window.__dshRoomPaintAuthors()
    await sleep(800)

    out.chips = [...document.querySelectorAll(".dsh-room-author")].slice(0, 6).map((chip) => ({
      text: String(chip.textContent || "").trim().slice(0, 20),
      isStub: Boolean(chip.getAttribute("data-dsh-room-chipstub")),
      chain: chain(chip, 7),
    }))
    out.lines = [...document.querySelectorAll(".dsh-room-authorline")].slice(0, 6).map((line) => ({
      text: String(line.textContent || "").trim().slice(0, 20),
      linefor: line.getAttribute("data-dsh-room-linefor"),
      self: info(line),
      parent: info(line.parentElement),
      siblings: line.parentElement
        ? [...line.parentElement.children].slice(0, 6).map((el) => info(el))
        : [],
      prev: info(line.previousElementSibling),
      next: info(line.nextElementSibling),
    }))
    out.chipCount = document.querySelectorAll(".dsh-room-author").length
    out.lineCount = document.querySelectorAll(".dsh-room-authorline").length
    out.stubCount = document.querySelectorAll("[data-dsh-room-chipstub]").length
  } catch (error) {
    out.error = String(error && error.message ? error.message : error)
  }
  return JSON.stringify(out, null, 2)
})()
