/**
 * 真机验收：胶囊独占一行（块级 + 满宽），且不插任何节点。
 * 重点量位置：胶囊底边必须 <= 正文顶边（= 正文被挤到下一行），胶囊宽度接近容器宽度。
 * 两种文本形状都测：① 房间推送 `〔@名字〕【房间消息·群】正文`（标记后无换行）
 *                 ② 房主召唤 `〔@房主〕\n正文`
 *
 * 用法：node test/probe-run.mjs --url=http://127.0.0.1:8787/ --wait=9000 \
 *        --js=test/probe-chip-ownline.js --port=9490
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = {}
  const paint = () => { if (typeof window.__dshRoomPaintAuthors === 'function') window.__dshRoomPaintAuthors() }
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) } }
  const mk = (text) => {
    const box = document.createElement('div')
    box.style.cssText = 'width:420px;padding:8px 10px;border:1px solid #dcdfe6;border-radius:10px;margin:8px 0'
    const line = document.createElement('div')
    line.appendChild(document.createTextNode(text))
    box.appendChild(line)
    document.body.appendChild(box)
    return { box, line }
  }
  try {
    await sleep(2500)

    // ① 房间推送形状（标记后无换行）
    const push = mk('〔@访客A〕【房间消息·agent聊天室】@总监 胶囊位置回归测试：正文正文')
    paint(); await sleep(350)
    const chipPush = push.line.querySelector('.dsh-room-author')
    out.pushChipCreated = Boolean(chipPush)
    out.pushChipClass = chipPush ? String(chipPush.className) : null
    out.pushChipDisplay = chipPush && chipPush.style.display !== 'none'
    out.pushChipRect = chipPush ? rect(chipPush) : null
    out.pushBoxRect = rect(push.box)
    // 正文是否被挤到胶囊下面：胶囊底边 <= 正文首行顶部（用 textNode 的 range 量）
    out.pushTextOnNextLine = (() => {
      if (!chipPush) return null
      const range = document.createRange()
      const walker = document.createTreeWalker(push.line, 4, null, false)
      let node = walker.nextNode(); let target = null
      while (node) { if (String(node.nodeValue || '').indexOf('房间消息') >= 0) { target = node; break } node = walker.nextNode() }
      if (!target) return null
      range.selectNodeContents(target)
      const first = range.getClientRects()[0]
      if (!first) return null
      return Math.round(first.top) >= Math.round(chipPush.getBoundingClientRect().bottom) - 2
    })()
    out.pushChipFullWidth = Boolean(chipPush && out.pushBoxRect && chipPush.getBoundingClientRect().width > out.pushBoxRect.w - 40)
    out.pushNoLineNode = push.box.querySelectorAll('.dsh-room-authorline').length === 0
    out.pushTextKept = String(push.box.textContent || '').indexOf('胶囊位置回归测试：正文正文') >= 0

    // ② 房主召唤形状（有换行）
    const summon = mk('〔@房主〕\n直接召唤的正文')
    paint(); await sleep(350)
    const chipSummon = summon.line.querySelector('.dsh-room-author')
    out.summonChipCreated = Boolean(chipSummon)
    out.summonChipRect = chipSummon ? rect(chipSummon) : null
    out.summonTextKept = String(summon.box.textContent || '').indexOf('直接召唤的正文') >= 0
    out.summonNoLineNode = summon.box.querySelectorAll('.dsh-room-authorline').length === 0

    // ③ 连跑多轮不堆积
    paint(); paint()
    await sleep(400)
    out.lineNodes = document.querySelectorAll('.dsh-room-authorline').length
    out.chipCount = document.querySelectorAll('.dsh-room-author').length

    push.box.remove(); summon.box.remove()
  } catch (error) {
    out.error = String(error && error.message ? error.message : error)
  }
  return JSON.stringify(out, null, 2)
})()
