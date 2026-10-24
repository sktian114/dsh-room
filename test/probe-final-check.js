(() => ({
  sendHooked: Boolean(window.__dshRoomSendHooked),
  markedCount: Number(window.__dshRoomMarkedCount || 0),
  hasMarkPrompt: typeof window.__dshRoomMarkPrompt === 'function',
  sampleMark: typeof window.__dshRoomMarkPrompt === 'function'
    ? (() => {
        const frame = JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'session/prompt', payload: { args: { request: { content: [{ type: 'text', text: '你好' }] } } } });
        const marked = window.__dshRoomMarkPrompt(frame);
        return marked ? JSON.parse(marked).payload.args.request.content[0].text : null;
      })()
    : null,
  accountRow: Boolean(document.querySelector('[data-dsh-room-account="1"]')),
  chipInsideAccount: Boolean(document.querySelector('[data-dsh-room-account="1"] [data-dsh-room-me]')),
  floatingChip: Boolean(document.querySelector('[data-dsh-room-me][data-floating="1"]')),
  settingsVisible: (() => { const el = document.querySelector('[class*="settingsArea"]'); return el ? getComputedStyle(el).display : null })(),
  rootDisplay: getComputedStyle(document.getElementById('root')).display,
  authorState: document.documentElement.getAttribute('data-dsh-room-author'),
}))()
