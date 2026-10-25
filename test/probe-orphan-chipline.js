/**
 * 真机验收「孤儿胶囊行会自己消失」：
 * 用户反馈：历史记录里，胶囊有时加载完后和悬浮行并列挤到最下面，并且永不消失。
 * 根因：胶囊被提升到气泡外以后，React 重渲染把消息节点（连同隐形占位）重建了，
 * 我们插在旁边的行留在 DOM 里 → 越堆越多、永远不走（0.3.13 加了 sweepAuthorLines 清理）。
 *
 * 这个探针造一条消息 → 让它长出胶囊行 → 模拟 React 重建（删掉原节点）→
 * 看下一轮画笔有没有把孤儿行清掉；再单独验证「插到滚动容器里的行」也会被撤回。
 *
 * 用法：node test/probe-run.mjs --url=http://127.0.0.1:8787/ --wait=8000 \
 *        --js=test/probe-orphan-chipline.js --port=9448
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = {}
  const paint = () => {
    if (typeof window.__dshRoomPaintAuthors === 'function') window.__dshRoomPaintAuthors()
  }
  try {
    out.hasPaintHook = typeof window.__dshRoomPaintAuthors === 'function'
    await sleep(3000)

    // ① 造一条「有兄弟节点 = 一条消息」的块，里面放带标记的正文
    // 结构模仿会话里的一屏消息：list（滚动）→ 每条消息一个 row → 气泡 → 文本
    const list = document.createElement('div')
    list.className = 'probe-orphan-list'
    const row = document.createElement('div')
    row.className = 'probe-orphan-row'
    const bubble = document.createElement('div')
    const text = document.createElement('div')
    text.appendChild(document.createTextNode('〔@访客A〕你好呀'))
    bubble.appendChild(text)
    row.appendChild(bubble)
    list.appendChild(row)
    const otherRow = document.createElement('div')
    otherRow.appendChild(document.createTextNode('（另一条消息）'))
    list.appendChild(otherRow)
    document.body.appendChild(list)

    paint()
    await sleep(300)
    const line = document.querySelector('.dsh-room-authorline')
    out.promoted = Boolean(line)
    out.linePlaced = Boolean(line && list.contains(line) && !row.contains(line))
    const stub = row.querySelector('.dsh-room-author[data-dsh-room-chipstub]')
    out.stubHidden = Boolean(stub && stub.style.display === 'none')
    out.lineId = line ? line.getAttribute('data-dsh-room-linefor') : null

    // ② 模拟 React 重渲染：这一条消息的节点被换掉（占位跟着没了，行还留在 list 里）
    row.remove()
    await sleep(100)
    out.orphanStillThereBeforeSweep = Boolean(document.querySelector('.dsh-room-authorline[data-dsh-room-linefor="' + out.lineId + '"]'))
    paint()
    await sleep(200)
    out.orphanGoneAfterSweep = !document.querySelector('.dsh-room-authorline[data-dsh-room-linefor="' + out.lineId + '"]')
    list.remove()

    // ③ 行被外力删掉、占位还在：占位要放回可见（否则这段文字会一直隐形）
    const list2 = document.createElement('div')
    const row2 = document.createElement('div')
    const bubble2nd = document.createElement('div')
    const text2nd = document.createElement('div')
    text2nd.appendChild(document.createTextNode('〔@访客C〕第三条'))
    bubble2nd.appendChild(text2nd)
    row2.appendChild(bubble2nd)
    list2.appendChild(row2)
    const other2 = document.createElement('div')
    other2.appendChild(document.createTextNode('（另一条）'))
    list2.appendChild(other2)
    document.body.appendChild(list2)
    paint()
    await sleep(250)
    const line2 = document.querySelector('.dsh-room-authorline[data-dsh-room-linefor="' + (function () {
      const s = row2.querySelector('[data-dsh-room-chipstub]')
      return s ? s.getAttribute('data-dsh-room-chipstub') : ''
    }()) + '"]')
    out.reverseLineFound = Boolean(line2)
    if (line2) line2.remove()
    paint()
    await sleep(250)
    const stub2 = row2.querySelector('.dsh-room-author[data-dsh-room-chipinline]')
    out.stubRestoredVisible = Boolean(stub2 && stub2.style.display !== 'none')
    out.stubTextReadable = Boolean(row2.textContent && row2.textContent.indexOf('访客C') >= 0)
    list2.remove()

    // ④ 插到「滚动容器」里的行必须被撤回，并且气泡里的文字要重新可见
    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    scroller.style.height = '80px'
    scroller.className = 'probe-scroller'
    const bubble2 = document.createElement('div')
    const text2 = document.createElement('div')
    text2.appendChild(document.createTextNode('〔@访客B〕第二条'))
    bubble2.appendChild(text2)
    scroller.appendChild(bubble2)
    document.body.appendChild(scroller)
    paint()
    await sleep(200)
    // 手工造一个「插错了地方」的行（模拟历史 bug 的产物）
    const bad = document.createElement('div')
    bad.className = 'dsh-room-authorline'
    bad.setAttribute('data-dsh-room-authorline', '1')
    bad.setAttribute('data-dsh-room-linefor', 'z9')
    bad.appendChild(document.createTextNode('孤儿'))
    scroller.appendChild(bad)
    out.badPlaceBefore = Boolean(scroller.querySelector('.dsh-room-authorline[data-dsh-room-linefor="z9"]'))
    paint()
    await sleep(200)
    out.badPlaceGone = !scroller.querySelector('.dsh-room-authorline[data-dsh-room-linefor="z9"]')

    // ④ 幂等：再多跑两轮不该越堆越多
    paint(); paint()
    await sleep(300)
    out.linesAfter = document.querySelectorAll('.dsh-room-authorline').length
    out.chipsAfter = document.querySelectorAll('.dsh-room-author').length

    scroller.remove()
  } catch (error) {
    out.error = String(error && error.message ? error.message : error)
  }
  return JSON.stringify(out, null, 2)
})()
