(() => {
  // 只负责「打开一个会话」，然后让 --type 用真键盘输入发消息
  const candidates = Array.from(document.querySelectorAll('[class]')).filter((el) => {
    const t = String(el.textContent || '').trim();
    return t.length > 4 && t.length < 40 && el.children.length <= 3 && /文字|会话|你好/.test(t);
  });
  const row = candidates[candidates.length - 1];
  if (row) row.click();
  return { clicked: Boolean(row), text: row ? String(row.textContent).trim().slice(0, 30) : null };
})()
