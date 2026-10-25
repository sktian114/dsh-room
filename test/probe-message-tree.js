/**
 * 只读：把会话视图里「消息行」这一层的结构打出来（深度优先前 N 个节点 + 类名 + 文本片段），
 * 目的：找到「一条消息的外层容器」长什么样，胶囊行该挂在哪一层才不会掉进 flex 列表。
 * 用法：node test/probe-run.mjs --url=http://127.0.0.1:8787/ --wait=10000 \
 *        --js=test/probe-message-tree.js --port=9463
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = { tree: [] }
  const brief = (el, depth) => {
    const rect = el.getBoundingClientRect()
    let style = null
    try { style = window.getComputedStyle(el) } catch (e) { style = null }
    return {
      d: depth,
      tag: el.tagName,
      cls: String(el.className || "").slice(0, 46),
      slot: el.getAttribute ? (el.getAttribute("data-slot") || "") : "",
      display: style ? style.display : "",
      overflowY: style ? style.overflowY : "",
      h: Math.round(rect.height),
      kids: el.children.length,
      text: String(el.textContent || "").trim().slice(0, 26),
    }
  }
  try {
    await sleep(2500)
    const pick = (name) => [...document.querySelectorAll("[class]")]
      .filter((el) => {
        const text = String(el.textContent || "").trim()
        if (text !== name) return false
        if (el.children.length > 3) return false
        const rect = el.getBoundingClientRect()
        return rect.width > 20 && rect.height > 8
      })
      .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0]
    const target = pick("插件-聊天室之主") || pick("总监")
    if (target) {
      const rect = target.getBoundingClientRect()
      const init = { bubbles: true, cancelable: true, clientX: rect.x + 5, clientY: rect.y + 5, button: 0 }
      for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) target.dispatchEvent(new MouseEvent(type, init))
      await sleep(4500)
    }
    const scroller = [...document.querySelectorAll("[data-conversation-scroll]")][0]
    out.hasScroller = Boolean(scroller)
    if (scroller) {
      // 逐层往下，只走「有文本、非轮次导航」的分支，最多 40 个节点
      const walk = (el, depth) => {
        if (!el || depth > 7 || out.tree.length >= 40) return
        if (el.classList && String(el.className).indexOf("SNx2jG_") === 0) return   // 轮次导航，跳过
        out.tree.push(brief(el, depth))
        for (const kid of [...el.children].slice(0, 3)) walk(kid, depth + 1)
      }
      walk(scroller, 0)
    }
  } catch (error) {
    out.error = String(error && error.message ? error.message : error)
  }
  return JSON.stringify(out, null, 2)
})()
