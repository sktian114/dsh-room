(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { steps: [] };

  // 先把会话打开，这样胶囊才有地方渲染
  const rows = Array.from(document.querySelectorAll('[class]')).filter((el) => {
    const t = String(el.textContent || '').trim();
    return t.length > 4 && t.length < 40 && el.children.length <= 3 && /文字|会话|你好/.test(t);
  });
  const row = rows[rows.length - 1];
  if (row) row.click();
  await sleep(3000);

  let current = null;
  try { current = window.localStorage.getItem('dsh.sessions.current') } catch { current = null }
  out.current = String(current || '').slice(0, 120);
  let sessionId = null;
  try {
    const parsed = JSON.parse(String(current || 'null'));
    if (typeof parsed === 'string') sessionId = parsed;
    else if (parsed && typeof parsed === 'object') sessionId = parsed.sessionId || parsed.id || null;
  } catch { sessionId = String(current || '').replace(/^"|"$/g, '') || null }
  if (!sessionId) {
    const key = Object.keys(window.localStorage).find((k) => k.indexOf('dsh.conversation.session-') === 0);
    if (key) sessionId = key.replace('dsh.conversation.session-', '');
  }
  if (sessionId) sessionId = String(sessionId).replace(/^session-/, '');
  out.sessionId = sessionId;
  if (!sessionId) return out;

  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/remote.mux';
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    let frame = null;
    try { frame = JSON.parse(String(event.data)) } catch { return }
    const id = frame && (frame.rpcId || (frame.payload && frame.payload.rpcId));
    if (id && pending.has(id)) { pending.get(id)(frame); pending.delete(id) }
  });
  const rpc = (method, args) => new Promise((resolve) => {
    const rpcId = 'probe-' + Math.random().toString(36).slice(2);
    pending.set(rpcId, resolve);
    // 故意走 WebSocket.prototype.send —— 宿主插件就是在这上面加标记
    ws.send(JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }));
    setTimeout(() => { if (pending.has(rpcId)) { pending.delete(rpcId); resolve({ timeout: true }) } }, 15000);
  });

  const before = Number(window.__dshRoomMarkedCount || 0);
  const response = await rpc('session/prompt', {
    request: {
      requestId: 'probe-' + Date.now(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: '房客自测：这条指令应当带上作者标记' }],
    },
  });
  out.response = JSON.stringify(response).slice(0, 400);
  out.markedCount = { before, after: Number(window.__dshRoomMarkedCount || 0) };
  out.lastMarked = String(window.__dshRoomLastMarked || '').slice(0, 200);

  await sleep(7000);
  const chips = Array.from(document.querySelectorAll('.dsh-room-author')).map((el) => String(el.textContent || '').trim());
  out.chips = { count: chips.length, labels: chips.slice(0, 5) };
  out.authorState = document.documentElement.getAttribute('data-dsh-room-author');
  out.markerInDom = String(document.body.textContent || '').indexOf('〔@') >= 0;
  try { ws.close() } catch { /* 忽略 */ }
  return out;
})()
