(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 打开会话，然后看对话里有没有渲染出「头像 + 昵称」胶囊
  const rows = Array.from(document.querySelectorAll('[class]')).filter((el) => {
    const t = String(el.textContent || '').trim();
    return t.length > 4 && t.length < 40 && el.children.length <= 3 && /文字|会话|你好/.test(t);
  });
  const row = rows[rows.length - 1];
  if (row) row.click();
  await sleep(3500);
  const chips = Array.from(document.querySelectorAll('.dsh-room-author'));
  return {
    clicked: Boolean(row),
    authorState: document.documentElement.getAttribute('data-dsh-room-author'),
    chipCount: chips.length,
    chipLabels: chips.slice(0, 4).map((el) => String(el.textContent || '').trim()),
    chipHtml: chips.length ? chips[0].outerHTML.slice(0, 240) : null,
    markerTextInDom: String(document.body.textContent || '').indexOf('〔@房客验收〕') >= 0,
    hasAvatar: chips.length ? Boolean(chips[0].querySelector('.dsh-room-authoravatar')) : false,
    avatarText: chips.length && chips[0].querySelector('.dsh-room-authoravatar') ? String(chips[0].querySelector('.dsh-room-authoravatar').textContent) : null,
  };
})()
