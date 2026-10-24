// 验证「胶囊被提到气泡外面独立成一行」：造一段假的消息 DOM（气泡里放一个作者胶囊），
// 调 paintAuthorChipsOnce，检查是否出现 .dsh-room-authorline 且在气泡**之前**。
(() => {
  const out = {}
  try {
    const root = document.createElement('div')
    root.id = 'probe-bubbles'
    root.innerHTML = [
      '<div class="msg-list" style="display:flex;flex-direction:column">',
      '  <div class="msg-item" data-probe="1">',
      '    <div><div class="bubble"><span class="dsh-room-author" data-dsh-room-chip="1">',
      '      <span class="dsh-room-authoravatar">鹿</span><span class="dsh-room-authorname">小鹿</span>',
      '    </span>帮我改一下标题</div></div>',
      '  </div>',
      '  <div class="msg-item" data-probe="2">',
      '    <div><div class="bubble">〔@阿伟〕第二句</div></div>',
      '  </div>',
      '</div>',
    ].join('')
    document.body.appendChild(root)

    const hooks = { paintAuthorChipsOnce: window.__dshRoomPaintAuthors }
    out.hasHooks = Boolean(hooks && typeof hooks.paintAuthorChipsOnce === 'function')
    if (out.hasHooks) hooks.paintAuthorChipsOnce()

    const first = root.querySelector('[data-probe="1"]')
    const second = root.querySelector('[data-probe="2"]')
    const lineOne = first.previousElementSibling
    out.firstLine = Boolean(lineOne && lineOne.classList.contains('dsh-room-authorline'))
    out.firstChipInsideLine = Boolean(lineOne && lineOne.querySelector('.dsh-room-author'))
    out.firstBubbleHasChip = Boolean(first.querySelector('.dsh-room-author'))

    // 第二条：标记文字要变成「气泡外的胶囊 + 气泡里只剩正文」
    const secondLine = second.previousElementSibling
    out.secondLine = Boolean(secondLine && secondLine.classList.contains('dsh-room-authorline'))
    out.secondLineText = secondLine ? String(secondLine.textContent || '').trim() : ''
    out.secondBubbleText = String(second.querySelector('.bubble')?.textContent || '').trim()
    out.lineCount = root.querySelectorAll('.dsh-room-authorline').length

    // 再跑一次：不能重复插入
    if (out.hasHooks) hooks.paintAuthorChipsOnce()
    out.lineCountAfterRerun = root.querySelectorAll('.dsh-room-authorline').length
    root.remove()
  } catch (error) {
    out.error = String(error && error.message ? error.message : error)
  }
  return JSON.stringify(out, null, 2)
})()

