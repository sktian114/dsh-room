(() => {
  const hidden = new Set(Array.from(document.querySelectorAll('[data-dsh-room-hidden="1"]')));
  const rows = [];
  const all = document.querySelectorAll('body *');
  for (const el of all) {
    let size = 0;
    try {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      size = parseFloat(style.fontSize) || 0;
      if (size < 16) continue;
      const text = String(el.textContent || '').trim().replace(/\s+/g, ' ');
      if (!text || text.length > 40) continue;
      if (el.querySelector('*')) {
        // 只保留最内层文本节点
        if (Array.from(el.children).some((child) => String(child.textContent || '').trim() === text)) continue;
      }
      const rect = el.getBoundingClientRect();
      rows.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className).slice(0, 60),
        text: text.slice(0, 40),
        fontSize: size,
        weight: style.fontWeight,
        x: Math.round(rect.x), y: Math.round(rect.y),
        w: Math.round(rect.width), h: Math.round(rect.height),
      });
    } catch (ignore) { /* skip */ }
  }
  const hiddenRows = Array.from(hidden).slice(0, 25).map((el) => ({
    tag: el.tagName.toLowerCase(),
    cls: String(el.className).slice(0, 50),
    text: String(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
  }));
  return {
    guestFlag: document.documentElement.getAttribute('data-dsh-room-guest'),
    bigText: rows.sort((a, b) => b.fontSize - a.fontSize).slice(0, 18),
    hiddenCount: hidden.size,
    hiddenSample: hiddenRows,
  };
})()
