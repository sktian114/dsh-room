(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = { steps: [] };

  // 1) 打开会话（点侧栏里那条标题）
  const candidates = Array.from(document.querySelectorAll('[class]')).filter((el) => {
    const t = String(el.textContent || '').trim();
    return t.length > 4 && t.length < 40 && el.children.length <= 3 && /文字|会话|你好/.test(t);
  });
  const row = candidates[candidates.length - 1];
  if (row) { row.click(); await sleep(2500) }

  // 2) 输入并发送（点发送按钮，不用回车）
  const editor = document.querySelector('[contenteditable="true"]');
  if (!editor) return { error: 'no editor' };
  editor.focus();
  document.execCommand('insertText', false, '房客自测：这条应该带作者标记');
  await sleep(500);
  const buttons = Array.from(document.querySelectorAll('button')).filter((b) => /发送|send/i.test(String(b.getAttribute('aria-label') || b.textContent || '')));
  log.steps.push({ step: 'sendButtons', count: buttons.length, labels: buttons.slice(0, 3).map((b) => String(b.getAttribute('aria-label') || b.textContent).slice(0, 20)) });
  if (buttons.length) { buttons[buttons.length - 1].click(); }
  else {
    const primary = document.querySelector('[class*="primary"]');
    log.steps.push({ step: 'primaryFallback', found: Boolean(primary) });
    if (primary) primary.click();
  }
  await sleep(4000);

  const chips = Array.from(document.querySelectorAll('.dsh-room-author')).map((el) => String(el.textContent || '').trim());
  log.steps.push({ step: 'chips', count: chips.length, labels: chips.slice(0, 5) });
  log.steps.push({ step: 'editorAfter', text: String(editor.textContent || '').slice(0, 30) });
  log.sendHooked = Boolean(window.__dshRoomSendHooked);
  log.authorState = document.documentElement.getAttribute('data-dsh-room-author');
  log.markedSample = (() => {
    const sample = JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'session/prompt', payload: { args: { request: { content: [{ type: 'text', text: '你好' }] } } } });
    try { return window.__dshRoomTestMark ? null : null } catch { return null }
  })();
  return log;
})()
