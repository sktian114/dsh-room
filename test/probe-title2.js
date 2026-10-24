(() => {
  const out = [];
  for (const el of document.querySelectorAll('[data-dsh-room-hidden="1"]')) {
    const rect = el.getBoundingClientRect();
    out.push({
      tag: el.tagName.toLowerCase(),
      cls: String(el.className).slice(0, 60),
      text: String(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30),
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.width), h: Math.round(rect.height),
      html: el.outerHTML.slice(0, 200).replace(/\s+/g, ' '),
    });
  }
  // 侧栏顶部区域的可视元素（左上角）
  const topLeft = Array.from(document.querySelectorAll('body *')).filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.x < 320 && rect.y < 120;
  }).slice(0, 14).map((el) => ({
    tag: el.tagName.toLowerCase(),
    cls: String(el.className).slice(0, 50),
    text: String(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 26),
    x: Math.round(el.getBoundingClientRect().x),
    y: Math.round(el.getBoundingClientRect().y),
    hidden: el.getAttribute('data-dsh-room-hidden') === '1',
  }));
  return { hidden: out, topLeft };
})()
