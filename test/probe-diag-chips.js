/**
 * 诊断：会话里到底有没有「【房间消息·…】」这种旧格式推送，以及别名对照表能不能拉到大全。
 * 用法：node test/probe-run.mjs --url=http://127.0.0.1:8787/ --wait=12000 --js=test/probe-diag-chips.js --port=9423
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
    // 同步接口能不能拿到群成员
    const guest = (() => { try { return JSON.parse(localStorage.getItem('dsh-room.guest') || 'null') } catch { return null } })()
    out.guest = guest ? { addr: guest.addr, hasToken: Boolean(guest.token) } : null
    const url = (guest && guest.addr ? guest.addr : '') + '/room/api/chat/sync?since=999999999'
      + (guest && guest.token ? '&token=' + encodeURIComponent(guest.token) : '')
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      const payload = await response.json()
      out.syncStatus = response.status
      out.syncOk = Boolean(payload && payload.ok)
      out.groupCount = payload && payload.groups ? payload.groups.length : 0
      const cmv = (payload && payload.groups || []).find((g) => g.id === 'cmvmccvr11')
      out.cmvmAgents = cmv ? cmv.agents.length : 0
      out.cmvmSample = cmv ? cmv.agents.slice(0, 3).map((a) => a.alias + ' | ' + a.id) : []
    } catch (error) {
      out.syncError = String(error && error.message ? error.message : error)
    }

    // 打开「总监」会话，看正文里有没有旧格式推送
    const title = [...document.querySelectorAll('span[class*="title"], div[class*="title"]')]
      .find((el) => String(el.textContent || '').trim() === '总监')
    if (title) { click(title); await sleep(7000) }
    const text = String(document.body.innerText || '')
    out.transcriptLen = text.length
    out.pushMarkers = (text.match(/【房间消息·/g) || []).length
    out.authorMarks = (text.match(/〔@/g) || []).length
    const at = text.indexOf('【房间消息·')
    out.sample = at >= 0 ? text.slice(at, at + 120) : null
    const at2 = text.indexOf('〔@')
    out.sampleMark = at2 >= 0 ? text.slice(at2, at2 + 120) : null
    out.chips = document.querySelectorAll('.dsh-room-author').length
  } catch (error) {
    out.error = String(error && error.message ? error.message : error)
  }
  return JSON.stringify(out, null, 2)
})()
