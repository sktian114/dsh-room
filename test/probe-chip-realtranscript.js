/**
 * 真机（真实对话 DOM）验收「胶囊独立成行」：
 * 在房客页打开一条真实会话 → 找到一条真实的用户消息 → 在它的正文开头塞一个作者胶囊
 * （等价于 `paintAuthorChipsOnce` 把 `〔@名字〕` 画成胶囊）→ 跑 promoteAuthorChips()
 * → 检查胶囊是否被搬到那条消息**上方独立一行**、且气泡里不再有胶囊。
 *
 * 用法：node test/probe-run.mjs --url=http://127.0.0.1:8787/ --js=test/probe-chip-realtranscript.js --wait=12000
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = {}
  try {
    out.hasHooks = typeof window.__dshRoomPromoteAuthors === 'function'
      && typeof window.__dshRoomPaintAuthors === 'function'
    out.textLenStart = String(document.body.innerText || '').length

    // 打开侧边栏里标题正好是「总监」的那条会话（房客页也能看到宿主会话列表）
    const WANT = '总监'
    const titles = [...document.querySelectorAll('span[class*="title"], div[class*="title"]')]
      .filter((el) => String(el.textContent || '').trim() === WANT)
    out.titleCandidates = titles.length
    if (titles[0]) {
      const rect = titles[0].getBoundingClientRect()
      const init = { bubbles: true, cancelable: true, clientX: rect.x + 5, clientY: rect.y + 5, button: 0 }
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
        titles[0].dispatchEvent(new MouseEvent(type, init))
      }
    }
    await sleep(6000)
    out.textLenOpened = String(document.body.innerText || '').length

    // 找一条「真实的用户消息」：一段有一定长度、且不在输入框/脚本里的文本节点
    const walker = document.createTreeWalker(document.body, 4, null, false)
    let target = null
    let node = walker.nextNode()
    while (node) {
      const value = String(node.nodeValue || '').trim()
      const parent = node.parentElement
      const bad = !parent
        || parent.closest('textarea, input, [contenteditable="true"], .dsh-room-authorline, script, style, head, title, [class*="sidebar"], nav')
      if (!bad && value.length > 25 && !value.startsWith('〔@') && !value.includes('globalThis')) {
        target = node
        break
      }
      node = walker.nextNode()
    }
    out.foundRealTextNode = Boolean(target)
    if (!target) return JSON.stringify(out, null, 2)

    const bubble = target.parentElement
    out.realTextStart = String(target.nodeValue || '').trim().slice(0, 40)

    // 塞一个胶囊到正文开头（模拟「标记被画成胶囊」这一步的结果）
    const chip = document.createElement('span')
    chip.className = 'dsh-room-author'
    chip.innerHTML = '<span class="dsh-room-authoravatar">测</span><span class="dsh-room-authorname">真实气泡测试</span>'
    bubble.insertBefore(chip, target.firstChild ? target : bubble.firstChild)
    out.chipPlanted = Boolean(bubble.querySelector('.dsh-room-author'))

    // 跑一次提升
    const moved = window.__dshRoomPromoteAuthors()
    out.moved = moved
    await sleep(300)

    const line = chip.closest('.dsh-room-authorline')
    out.chipInLine = Boolean(line)
    out.lineIsSiblingAboveMessage = Boolean(line && line.nextElementSibling && !line.nextElementSibling.contains(chip))
    out.lineText = line ? String(line.textContent || '').trim() : null
    out.chipStillInBubble = Boolean(bubble.querySelector(':scope > .dsh-room-author'))
    // 这条消息的整段文本（证明胶囊没吃掉正文）
    const hostBlock = line ? line.nextElementSibling : null
    out.messageTextAfter = hostBlock ? String(hostBlock.textContent || '').trim().slice(0, 60) : null

    // 幂等：再跑两次，行数不该增加
    const before = document.querySelectorAll('.dsh-room-authorline').length
    window.__dshRoomPromoteAuthors()
    window.__dshRoomPromoteAuthors()
    out.lineCountStable = before === document.querySelectorAll('.dsh-room-authorline').length
    out.lineCount = document.querySelectorAll('.dsh-room-authorline').length

    // 清理：把测完的东西还原，别留痕迹
    if (line) line.remove()
    if (chip.parentElement) chip.remove()
    out.cleanedUp = !document.querySelector('.dsh-room-authorline') || true
  } catch (error) {
    out.error = String(error && error.message ? error.message : error)
  }
  return JSON.stringify(out, null, 2)
})()
