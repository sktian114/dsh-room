/**
 * 真机验收「聊天面板可拖动改大小」：
 * 打开宿主界面 → 确保房间聊天面板在 → 拖左边缘抓手 → 量宽高变化 + 是否落盘。
 *
 * 用法：node test/probe-run.mjs --url=http://127.0.0.1:8787/ --url2=http://127.0.0.1:51357/ \
 *        --wait=8000 --wait2=14000 --js=test/probe-resize-panel.js --port=9411
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = {}
  try {
    out.url = location.href
    // 打开房间聊天：先点「联机」按钮，再点面板里的「打开房间聊天」
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
    const opener = buttons.find((el) => /房间聊天|联机/.test(String(el.getAttribute('title') || ''))
      || /房间聊天|联机/.test(String(el.textContent || '').trim()))
    out.openerText = opener ? String(opener.textContent || '').trim().slice(0, 20) || String(opener.getAttribute('title') || '') : null
    if (opener) opener.click()
    await sleep(2500)
    const chatBtn = [...document.querySelectorAll('button')]
      .find((el) => String(el.getAttribute('title') || '') === '打开房间聊天')
    out.chatBtnFound = Boolean(chatBtn)
    if (chatBtn) chatBtn.click()
    await sleep(2500)

    let panel = document.querySelector('.dsh-room-chatpanel')
    out.panelFound = Boolean(panel)
    if (!panel) return JSON.stringify(out, null, 2)

    const grips = panel.querySelectorAll('.dsh-room-resize')
    out.grips = grips.length
    out.gripEdges = [...grips].map((el) => el.getAttribute('data-edge'))
    const before = panel.getBoundingClientRect()
    out.sizeBefore = { w: Math.round(before.width), h: Math.round(before.height) }

    // 拖左边缘往左 80px、往下 60px
    const grip = [...grips].find((el) => el.getAttribute('data-edge') === 'left')
      || [...grips].find((el) => el.getAttribute('data-edge') === 'right')
      || grips[0]
    if (grip) {
      const rect = grip.getBoundingClientRect()
      const startX = rect.x + rect.width / 2
      const startY = rect.y + rect.height / 2
      const ev = (type, x, y) => grip.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: 1,
      }))
      ev('pointerdown', startX, startY)
      await sleep(120)
      ev('pointermove', startX - 80, startY + 60)
      await sleep(200)
      ev('pointerup', startX - 80, startY + 60)
      await sleep(400)
    }
    const after = panel.getBoundingClientRect()
    out.sizeAfter = { w: Math.round(after.width), h: Math.round(after.height) }
    out.grewWider = out.sizeAfter.w > out.sizeBefore.w + 20
    out.grewTaller = out.sizeAfter.h > out.sizeBefore.h + 20
    out.stored = localStorage.getItem('dsh-room.chatsize')
    out.resizingAttr = panel.getAttribute('data-resizing')
  } catch (error) {
    out.error = String(error && error.message ? error.message : error)
  }
  return JSON.stringify(out, null, 2)
})()
