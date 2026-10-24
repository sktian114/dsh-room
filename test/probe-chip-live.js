(async () => {
  const out = { steps: [] };
  const area = document.querySelector('[class*="conversation"], main, #root');
  if (!area) return { error: 'no-area' };
  const holder = document.createElement('div');
  holder.setAttribute('data-probe-chip', '1');
  holder.style.cssText = 'position:fixed;left:-9999px;top:0';
  holder.textContent = '〔@小鹿〕帮我改一下标题';
  area.appendChild(holder);
  // 等 DOM 兜底那一轮扫（每 1.5 秒一次）
  await new Promise((resolve) => setTimeout(resolve, 2600));
  const chips = holder.querySelectorAll('.dsh-room-author');
  const chip = chips[0] || null;
  out.chipCount = chips.length;
  out.markerGone = String(holder.textContent || '').indexOf('〔@') < 0;
  out.leftText = String(holder.textContent || '').trim();
  if (chip) {
    out.chipText = String(chip.textContent || '').trim();
    out.chipTitle = chip.getAttribute('title');
    out.chipHtml = chip.outerHTML.slice(0, 220);
  }
  holder.remove();
  return out;
})()
