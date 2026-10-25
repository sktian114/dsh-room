/**
 * 只读：把真实会话里「一条消息」的 DOM 形状打出来（用来给胶囊提升逻辑做参照）。
 * 用法：node test/probe-run.mjs --url=http://127.0.0.1:8787/ --wait=10000 \
 *        --js=test/probe-message-shape.js --port=9462
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = {}
  const pick = (name) => [...document.querySelectorAll("[class]")]
    .filter((el) => {
      const text = String(el.textContent || "").trim()
      if (text !== name) return false
      if (el.children.length > 3) return false
      const rect = el.getBoundingClientRect()
      return rect.width > 20 && rect.height > 8
    })
    .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0]
  const brief = (el) => {
    if (!el || el.nodeType !== 1) return null
    const rect = el.getBoundingClientRect()
    let style = null
    try { style = window.getComputedStyle(el) } catch (e) { style = null }
    return {
      tag: el.tagName,
      cls: String(el.className || "").slice(0, 70),
      role: el.getAttribute ? (el.getAttribute("role") || "") : "",
      data: el.dataset ? Object.keys(el.dataset).slice(0, 4).join(",") : "",
      display: style ? style.display : "",
      overflowY: style ? style.overflowY : "",
      pos: style ? style.position : "",
      y: Math.round(rect.y), h: Math.round(rect.height), w: Math.round(rect.width),
      kids: el.children ? el.children.length : 0,
      text: String(el.textContent || "").trim().slice(0, 40),
    }
  }
  try {
    await sleep(3000)
    const target = pick("插件-聊天室之主") || pick("总监")
    if (target) {
      const rect = target.getBoundingClientRect()
      const init = { bubbles: true, cancelable: true, clientX: rect.x + 5, clientY: rect.y + 5, button: 0 }
      for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) target.dispatchEvent(new MouseEvent(type, init))
      await sleep(5000)
    }
    // 找到滚动容器里"像消息"的元素：直接容器子节点
    const scrollers = [...document.querySelectorAll("div")].filter((el) => {
      try {
        const s = window.getComputedStyle(el)
        return (s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 20
      } catch (e) { return false }
    })
    out.scrollers = scrollers.slice(0, 3).map(brief)
    const scroller = scrollers[0]
    if (scroller) {
      out.scrollerChildren = [...scroller.children].slice(0, 5).map(brief)
      const first = scroller.children[0]
      if (first) {
        out.firstChildChain = []
        let cur = first
        let n = 0
        while (cur && cur.nodeType === 1 && n < 4) { out.firstChildChain.push(brief(cur)); cur = cur.children[0]; n += 1 }
        out.firstChildHtml = String(first.outerHTML || "").slice(0, 700)
      }
      // 页面底部那些"悬浮"的东西：fixed/sticky 且靠底
      out.floating = [...document.querySelectorAll("div")].filter((el) => {
        try {
          const s = window.getComputedStyle(el)
          if (s.position !== "fixed" && s.position !== "sticky") return false
          const rect = el.getBoundingClientRect()
          return rect.bottom > window.innerHeight - 80 && rect.height > 10 && rect.width > 40
        } catch (e) { return false }
      }).slice(0, 6).map(brief)
    }
  } catch (error) {
    out.error = String(error && error.message ? error.message : error)
  }
  return JSON.stringify(out, null, 2)
})()
