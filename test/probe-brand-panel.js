(() => {
  const brand = document.querySelector('[class*="brand"]');
  const brandIdentity = document.querySelector('[class*="brandIdentity"]');
  const rect = brand && brand.getBoundingClientRect ? brand.getBoundingClientRect() : null;
  const hidden = [];
  for (const el of document.querySelectorAll('[data-dsh-room-hidden="1"]')) {
    hidden.push(String(el.className || el.tagName).slice(0, 40));
  }
  // 打开「我的身份」面板看一眼头像入口
  let panel = null;
  try {
    const chip = document.querySelector('[data-dsh-room-me]');
    if (chip && chip.listeners && chip.listeners.click && chip.listeners.click[0]) chip.listeners.click[0]({ preventDefault() {}, stopPropagation() {} });
    else if (chip && chip.click) chip.click();
    const pop = document.querySelector('[data-dsh-room-me-pop]');
    if (pop) {
      const inputs = [];
      const walk = (el) => { if (el.tagName === 'INPUT') inputs.push({ type: el.type, accept: el.accept || '' }); el.children.forEach(walk); };
      walk(pop);
      panel = { head: (pop.children[0] || {}).textContent || '', inputs };
    }
  } catch (error) { panel = { error: String(error && error.message || error) }; }
  return {
    brandFound: Boolean(brand),
    brandHidden: brand ? brand.getAttribute('data-dsh-room-hidden') : 'no-brand',
    brandSize: rect ? Math.round(rect.width) + 'x' + Math.round(rect.height) : 'n/a',
    brandIdentityVisible: brandIdentity ? !(getComputedStyle(brandIdentity).display === 'none') : 'missing',
    hiddenList: hidden,
    subtitle: (String(document.body.innerText).match(/同一网络内共享同一个 DSH 工作区/) || ['(无)'])[0],
    panel,
    texture: String(document.body.innerText).replace(/\s+/g, ' ').slice(0, 160),
  };
})()
