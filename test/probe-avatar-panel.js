(() => {
  const out = { steps: [] };
  try {
    const chip = document.querySelector('[data-dsh-room-me]');
    out.chipFound = Boolean(chip);
    if (chip) chip.click();
    const pop = document.querySelector('[data-dsh-room-me-pop]');
    out.popFound = Boolean(pop);
    if (pop) {
      const inputs = Array.from(pop.querySelectorAll('input')).map((el) => ({ type: el.type, accept: el.accept || '' }));
      const buttons = Array.from(pop.querySelectorAll('button')).map((el) => String(el.textContent || '').trim());
      out.panel = {
        head: String((pop.querySelector('div') || {}).textContent || '').trim().slice(0, 40),
        inputs,
        buttons,
        hasPreview: Boolean(pop.querySelector('[class*="dsh-room-me-avatarpreview"]')),
        text: String(pop.textContent || '').replace(/\s+/g, ' ').slice(0, 200),
      };
      const close = Array.from(pop.querySelectorAll('button')).find((el) => String(el.textContent || '').trim() === '取消');
      if (close) close.click();
    }
  } catch (error) {
    out.error = String((error && error.message) || error);
  }
  return out;
})()
