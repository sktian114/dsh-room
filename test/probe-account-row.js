(() => {
  const trigger = document.querySelector('[class*="settingsArea"] button') || document.querySelector('button[aria-label^="访客身份"]');
  const chip = document.querySelector('[data-dsh-room-me]');
  const settings = document.querySelector('[class*="settingsArea"]');
  const cs = (el) => { if (!el) return null; const s = getComputedStyle(el); return { display: s.display, color: s.color, fontSize: s.fontSize, padding: s.padding, height: s.height, radius: s.borderRadius } };
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.left) + ',' + Math.round(r.top) };
  const avatar = chip ? chip.querySelector('.dsh-room-meavatar') : null;
  const name = chip ? chip.querySelector('.dsh-room-mename') : null;
  const out = {
    settingsArea: { display: settings ? getComputedStyle(settings).display : null },
    trigger: trigger ? {
      cls: String(trigger.className),
      rect: rect(trigger),
      style: cs(trigger),
      attrs: { account: trigger.getAttribute('data-dsh-room-account'), hidden: trigger.getAttribute('data-dsh-room-hidden'), aria: trigger.getAttribute('aria-label'), title: trigger.getAttribute('title'), collapsed: trigger.getAttribute('data-collapsed') },
      visibleChildren: Array.from(trigger.children).filter((c) => getComputedStyle(c).display !== 'none').map((c) => String(c.className).slice(0, 30)),
    } : null,
    chip: chip ? {
      parentIsTrigger: chip.parentElement === trigger,
      parentCls: String(chip.parentElement && chip.parentElement.className).slice(0, 40),
      account: chip.getAttribute('data-account'),
      floating: chip.getAttribute('data-floating'),
      rect: rect(chip),
      name: name ? String(name.textContent) : null,
      avatar: avatar ? String(avatar.textContent) : null,
      avatarStyle: cs(avatar),
      nameStyle: cs(name),
    } : null,
    otherMeChips: document.querySelectorAll('[data-dsh-room-me]').length,
    rootDisplay: getComputedStyle(document.getElementById('root')).display,
    bodyTail: String(document.body.textContent || '').replace(/\s+/g, ' ').slice(-80),
  };
  // 点账号行 → 应该弹出「我的身份」小面板（不是房主的账号菜单）
  if (trigger) {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    out.afterClick = {
      editorOpen: Boolean(document.querySelector('[data-dsh-room-me-pop]')),
      hostMenuOpen: Boolean(document.querySelector('[role="menu"]')),
    };
    const pop = document.querySelector('[data-dsh-room-me-pop]');
    out.editorTitle = pop ? String(pop.textContent || '').replace(/\s+/g, ' ').slice(0, 60) : null;
  }
  return out;
})()
