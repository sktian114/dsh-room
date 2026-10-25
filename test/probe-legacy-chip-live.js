/**
 * 真机验收「旧格式推送的历史消息也能长出作者胶囊」：
 * 在宿主页面（cookie 有效 → 别名对照表能拉到）里造一段旧格式推送文本，跑一次画笔，
 * 检查：① 有没有胶囊 ② 名字是不是群里别名（不是 session-bb81）③ 有没有被提到消息上方。
 *
 * 用法：node test/probe-run.mjs --url=http://127.0.0.1:8787/ --url2=http://127.0.0.1:51357/ \
 *        --wait=6000 --wait2=14000 --js=test/probe-legacy-chip-live.js --port=9435
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = {}
  try {
    out.hasPaintHook = typeof window.__dshRoomPaintAuthors === 'function'
    // 等别名对照表预热（画笔画笔会自己拉 /room/api/chat/sync）
    await sleep(4000)

    // 造一个「消息块」：外层多兄弟 = 一条消息，内层单链 = 气泡
    const host = document.createElement('div')
    host.className = 'probe-legacy-msg'
    const inner = document.createElement('div')
    const p = document.createElement('p')
    p.appendChild(document.createTextNode('【房间消息·agent聊天室】session-bb81：这条是旧格式推送，应该补出胶囊'))
    inner.appendChild(p)
    host.appendChild(inner)
    const sibling = document.createElement('div')
    sibling.appendChild(document.createTextNode('（同一条消息里的第二个块）'))
    host.appendChild(sibling)
    document.body.appendChild(host)

    const before = document.querySelectorAll('.dsh-room-author').length
    window.__dshRoomPaintAuthors()
    await sleep(400)
    const chips = [...host.querySelectorAll('.dsh-room-author')]
    const lines = [...document.querySelectorAll('.dsh-room-authorline')]
    out.chipCreated = chips.length
    out.chipText = chips.length ? String(chips[0].textContent || '').trim() : null
    out.namedNotSessionId = Boolean(out.chipText && !/session-/.test(out.chipText))
    out.lineAboveMessage = lines.some((line) => line.nextElementSibling === host)
    out.msgTextKept = String(host.textContent || '').includes('这条是旧格式推送')
    out.chipBeforeTotal = before
    out.linesTotal = lines.length

    // 幂等：再跑两次不该多出胶囊
    window.__dshRoomPaintAuthors()
    window.__dshRoomPaintAuthors()
    await sleep(300)
    out.idempotent = host.querySelectorAll('.dsh-room-author').length === out.chipCreated
      && document.querySelectorAll('.dsh-room-authorline').length === lines.length

    // 清理
    host.remove()
    lines.forEach((line) => { if (!line.textContent) line.remove() })
    out.cleaned = !document.querySelector('.probe-legacy-msg')
  } catch (error) {
    out.error = String(error && error.message ? error.message : error)
  }
  return JSON.stringify(out, null, 2)
})()
