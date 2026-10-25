/**
 * 诊断：打开会话后，DOM 里到底有没有推送文本（含新标记）/胶囊。
 * 用法：node test/probe-run.mjs --url=http://127.0.0.1:8787/ --url2=http://127.0.0.1:51357/ --wait=6000 --wait2=14000 --js=test/probe-diag-dom.js --port=9429
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = {}
  const click = (el) => {
    if (!el) return false
    const rect = el.getBoundingClientRect()
    const init = { bubbles: true, cancelable: true, clientX: rect.x + 5, clientY: rect.y + 5, button: 0 }
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, init))
    return true
  }
  try {
    const title = [...document.querySelectorAll('span[class*="title"], div[class*="title"]')]
      .find((el) => String(el.textContent || '').trim() === '插件-聊天室之主')
    out.sessionFound = Boolean(title)
    if (title) { click(title); await sleep(8000) }
    const text = String(document.body.innerText || '')
    out.len = text.length
    out.head = text.slice(0, 120)
    out.tail = text.slice(-400)
    out.hasAliasText = text.includes('插件#c555cd')
    out.hasPushEnvelope = text.includes('【房间消息·')
    out.hasMark = text.includes('〔@')
    out.chips = document.querySelectorAll('.dsh-room-author').length
    out.lines = document.querySelectorAll('.dsh-room-authorline').length
    // 滚动到最底部，等画家再跑一轮
    const scrollers = [...document.querySelectorAll('div')]
      .filter((el) => el.scrollHeight > el.clientHeight + 40)
    out.scrollers = scrollers.length
    scrollers.forEach((el) => { el.scrollTop = el.scrollHeight })
    await sleep(4000)
    const text2 = String(document.body.innerText || '')
    out.afterScroll = {
      len: text2.length,
      hasAliasText: text2.includes('插件#c555cd'),
      hasPushEnvelope: text2.includes('【房间消息·'),
      hasMark: text2.includes('〔@'),
      chips: document.querySelectorAll('.dsh-room-author').length,
      lines: document.querySelectorAll('.dsh-room-authorline').length,
      lineTexts: [...document.querySelectorAll('.dsh-room-authorline')].slice(0, 5)
        .map((el) => String(el.textContent || '').trim()),
    }
  } catch (error) {
    out.error = String(error && error.message ? error.message : error)
  }
  return JSON.stringify(out, null, 2)
})()
