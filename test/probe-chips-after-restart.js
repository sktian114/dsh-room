/**
 * 真机验收「重启后历史消息的发送者胶囊还在」：
 * 房客页 → 先让聊天面板同步一次群成员（别名对照表靠它）→ 打开「总监」会话
 * → 数一数作者胶囊/作者行，并看看历史推送（旧格式 `【房间消息·…】session-bb81：…`）有没有被翻成别名。
 *
 * 用法：node test/probe-run.mjs --url=http://127.0.0.1:8787/ --wait=12000 --js=test/probe-chips-after-restart.js --port=9417
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = {}
  const click = (el) => {
    if (!el) return false
    const rect = el.getBoundingClientRect()
    const init = { bubbles: true, cancelable: true, clientX: rect.x + 5, clientY: rect.y + 5, button: 0 }
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, init))
    }
    return true
  }
  try {
    // 1) 让聊天面板跑一次同步：群成员 → 别名对照表
    const chatEntry = [...document.querySelectorAll('button')]
      .find((el) => String(el.getAttribute('title') || '') === '打开房间聊天')
    out.chatEntryFound = Boolean(chatEntry)
    if (chatEntry) { click(chatEntry); await sleep(3500) }
    out.panelOpen = Boolean(document.querySelector('.dsh-room-chatpanel'))

    // 2) 打开「总监」会话（历史里装着我之前推过去的房间消息）
    const title = [...document.querySelectorAll('span[class*="title"], div[class*="title"]')]
      .find((el) => String(el.textContent || '').trim() === '总监')
    out.sessionFound = Boolean(title)
    if (title) { click(title); await sleep(7000) }

    out.transcriptLen = String(document.body.innerText || '').length
    out.chips = document.querySelectorAll('.dsh-room-author').length
    out.lines = document.querySelectorAll('.dsh-room-authorline').length
    out.lineTexts = [...document.querySelectorAll('.dsh-room-authorline')]
      .slice(0, 6).map((el) => String(el.textContent || '').trim())
    out.hasAlias = out.lineTexts.some((t) => t.includes('杂项'))
    out.legacyChips = document.querySelectorAll('[data-dsh-room-legacychip]').length
    // 提升后的胶囊应该在气泡外面：每一行都是某个消息块的兄弟的前一个兄弟
    out.promotedOutsideBubble = [...document.querySelectorAll('.dsh-room-authorline')]
      .every((line) => !(line.parentElement && line.parentElement.querySelector('.dsh-room-author')
        && line.parentElement.classList.contains('dsh-room-chatpanel')))
  } catch (error) {
    out.error = String(error && error.message ? error.message : error)
  }
  return JSON.stringify(out, null, 2)
})()
