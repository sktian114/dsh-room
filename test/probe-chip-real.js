(() => {
  const out = {}
  try {
    const text = String(document.body.innerText || '')
    out.markersInText = (text.match(/〔@/g) || []).length
    out.chips = document.querySelectorAll('.dsh-room-author').length
    out.lines = document.querySelectorAll('.dsh-room-authorline').length
    const strays = []
    document.querySelectorAll('.dsh-room-author').forEach((chip) => {
      if (!chip.closest('.dsh-room-authorline')) {
        strays.push(String(chip.textContent || '').trim())
      }
    })
    out.chipsNotInLine = strays
    // 胶囊那一行的下一个兄弟应该就是消息气泡本体
    const line = document.querySelector('.dsh-room-authorline')
    if (line) {
      const chip = line.querySelector('.dsh-room-author')
      out.lineText = String(line.textContent || '').trim()
      const next = line.nextElementSibling
      out.lineNextTag = next ? next.tagName + '.' + String(next.className || '').split(' ').slice(0, 2).join('.') : null
      out.lineNextTextStart = next ? String(next.textContent || '').trim().slice(0, 40) : null
      out.chipInsideNext = Boolean(next && chip && next.contains(chip))
      // 这一行是否与气泡同一父容器（= 同一条消息内、气泡上方）
      out.sameParent = Boolean(next && line.parentElement === next.parentElement)
      out.lineHtml = String(line.outerHTML).slice(0, 220)
    }
    out.lastLineTexts = [...document.querySelectorAll('.dsh-room-authorline')].slice(-3).map((el) => String(el.textContent || '').trim())
  } catch (error) {
    out.error = String(error && error.message ? error.message : error)
  }
  return JSON.stringify(out, null, 2)
})()
