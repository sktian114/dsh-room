/**
 * 真机验收「胶囊独立成行」：在 DSH 宿主界面里打开某个会话，检查真实对话气泡上的胶囊位置。
 * 两段式：`--url=http://127.0.0.1:8787/ --url2=http://127.0.0.1:59740/`（第一段只为拿 dsh-auth cookie）。
 * 会话靠标题前缀找：改下面的 WANT。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const WANT = '总监'
  const out = {}
  try {
    out.url = location.href
    out.textLen = String(document.body.innerText || '').length

    // 侧边栏条目：取「含标题文本、且没有更小的同类子元素」的那些，取最深的一个来点
    const all = [...document.querySelectorAll('button, a, [role="button"], li, div, span')]
    const hits = all.filter((el) => String(el.textContent || '').trim().startsWith(WANT))
    const deepest = hits.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0]
    out.candidates = hits.length
    out.pickedTag = deepest ? deepest.tagName : null
    out.pickedText = deepest ? String(deepest.textContent || '').trim().slice(0, 40) : null
    out.pickedClass = deepest ? String(deepest.className || '').slice(0, 80) : null
    if (deepest) {
      // 逐层往上点，直到右侧对话区真的出现内容（React 有时把事件挂在行容器上）
      let el = deepest
      for (let level = 0; level < 5 && el; level += 1) {
        const rect = el.getBoundingClientRect()
        const init = { bubbles: true, cancelable: true, clientX: rect.x + 5, clientY: rect.y + 5, button: 0 }
        el.dispatchEvent(new MouseEvent('pointerdown', init))
        el.dispatchEvent(new MouseEvent('mousedown', init))
        el.dispatchEvent(new MouseEvent('mouseup', init))
        el.dispatchEvent(new MouseEvent('click', init))
        await sleep(1800)
        out['level' + level] = el.tagName + '.' + String(el.className || '').split(' ')[0]
        out['textLenAfter' + level] = String(document.body.innerText || '').length
        if (String(document.body.innerText || '').length > 600) break
        el = el.parentElement
      }
    }

    const text = String(document.body.innerText || '')
    out.markersInTranscript = (text.match(/〔@/g) || []).length
    out.chips = document.querySelectorAll('.dsh-room-author').length
    out.lines = document.querySelectorAll('.dsh-room-authorline').length
    const strays = []
    document.querySelectorAll('.dsh-room-author').forEach((chip) => {
      if (!chip.closest('.dsh-room-authorline')) strays.push(String(chip.textContent || '').trim())
    })
    out.chipsNotInLine = strays
    const lines = [...document.querySelectorAll('.dsh-room-authorline')]
    out.lastLines = lines.slice(-3).map((line) => {
      const next = line.nextElementSibling
      return {
        lineText: String(line.textContent || '').trim(),
        sameParentAsNext: Boolean(next && line.parentElement === next.parentElement),
        chipInsideNext: Boolean(next && next.querySelector('.dsh-room-author')),
        hasPrevSibling: Boolean(line.previousElementSibling),
        nextTextStart: next ? String(next.textContent || '').trim().slice(0, 30) : null,
      }
    })
    // 还没被提升的残留标记（说明画的时候没命中真实 DOM 形状）
    const strayMarks = []
    const walker = document.createTreeWalker(document.body, 4, null, false)
    let node = walker.nextNode()
    while (node) {
      const value = String(node.nodeValue || '')
      if (value.includes('〔@')) strayMarks.push(value.trim().slice(0, 40))
      node = walker.nextNode()
    }
    out.strayMarkers = strayMarks.slice(0, 5)
  } catch (error) {
    out.error = String(error && error.message ? error.message : error)
  }
  return JSON.stringify(out, null, 2)
})()
