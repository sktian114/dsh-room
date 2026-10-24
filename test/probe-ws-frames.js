(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = [];
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/remote.mux';
  const ws = new WebSocket(url);
  const opened = await new Promise((resolve) => {
    ws.addEventListener('open', () => resolve('open'), { once: true });
    ws.addEventListener('error', () => resolve('error'), { once: true });
    ws.addEventListener('close', () => resolve('close'), { once: true });
    setTimeout(() => resolve('timeout'), 8000);
  });
  ws.addEventListener('message', (event) => { if (frames.length < 8) frames.push(String(event.data).slice(0, 300)) });
  const request = {
    requestId: 'probe-' + Date.now(),
    sessionId: '34e72c5b-41d2-4d42-b6f3-99be95856b83',
    mode: 'queue',
    content: [{ type: 'text', text: '房客自测：这条指令应当带上作者标记' }],
  };
  ws.send(JSON.stringify({ type: 'client-request', rpcId: 'probe-a', method: 'session/list', payload: { args: { _request: {} } } }));
  await sleep(1500);
  ws.send(JSON.stringify({ type: 'client-request', rpcId: 'probe-b', method: 'session/prompt', payload: { args: { request } } }));
  await sleep(6000);
  try { ws.close() } catch { /* 忽略 */ }
  return { opened, frames, markedCount: Number(window.__dshRoomMarkedCount || 0), lastMarked: String(window.__dshRoomLastMarked || '').slice(0, 120) };
})()
