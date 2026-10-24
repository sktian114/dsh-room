(() => {
  const pick = (sel) => document.querySelector(sel);
  const trigger = pick('[class*="settingsArea"] button') || pick('button[aria-label="账号菜单"]');
  if (!trigger) return '(no trigger)';
  const cs = (el, props) => { const s = getComputedStyle(el); const out = {}; for (const p of props) out[p] = s.getPropertyValue(p); return out };
  const props = ['display', 'align-items', 'gap', 'padding', 'margin', 'height', 'width', 'border-radius', 'font-size', 'font-weight', 'line-height', 'color', 'background-color', 'text-align'];
  const avatar = trigger.querySelector('[class*="avatar"]');
  const label = trigger.querySelector('[class*="label"]');
  const r = trigger.getBoundingClientRect();
  return {
    triggerCls: String(trigger.className),
    triggerAttrs: { collapsed: trigger.getAttribute('data-collapsed'), signedOut: trigger.getAttribute('data-signed-out'), aria: trigger.getAttribute('aria-label') },
    triggerRect: Math.round(r.width) + 'x' + Math.round(r.height),
    triggerStyle: cs(trigger, props),
    avatarCls: avatar ? String(avatar.className) : null,
    avatarRect: avatar ? (() => { const a = avatar.getBoundingClientRect(); return Math.round(a.width) + 'x' + Math.round(a.height) })() : null,
    avatarStyle: avatar ? cs(avatar, ['display', 'width', 'height', 'border-radius', 'border', 'background-color', 'color']) : null,
    labelCls: label ? String(label.className) : null,
    labelStyle: label ? cs(label, ['font-size', 'font-weight', 'color', 'line-height', 'margin']) : null,
    labelText: label ? String(label.textContent) : null,
    triggerOuterHtml: trigger.outerHTML.slice(0, 300),
    settingsAreaStyle: (() => { const sa = document.querySelector('[class*="settingsArea"]'); return sa ? cs(sa, ['display', 'padding', 'margin', 'gap']) : null })(),
    collapsedSidebar: (() => { const el = document.querySelector('[data-collapsed]'); return el ? String(el.getAttribute('data-collapsed')) : null })(),
  };
})()
