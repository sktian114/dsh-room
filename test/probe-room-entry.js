(() => {
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
  const roomEntry = buttons.filter((b) => /联机|房间/.test(String(b.getAttribute('aria-label') || b.textContent || '')));
  return {
    composerRowText: (() => {
      const editor = document.querySelector('[contenteditable="true"]');
      const row = editor ? editor.closest('[class*="GRgSLq_"]') : null;
      return row ? String(row.textContent || '').replace(/\s+/g, ' ').slice(0, 120) : null;
    })(),
    roomEntryCount: roomEntry.length,
    roomEntries: roomEntry.slice(0, 4).map((b) => ({
      label: String(b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 16),
      cls: String(b.className).slice(0, 40),
      visible: getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 0,
    })),
    slotNodes: Array.from(document.querySelectorAll('[data-slot*="input"]')).map((el) => el.getAttribute('data-slot')),
    meChip: Boolean(document.querySelector('[data-dsh-room-me]')),
    accountRow: Boolean(document.querySelector('[data-dsh-room-account="1"]')),
    authorState: document.documentElement.getAttribute('data-dsh-room-author'),
  };
})()
