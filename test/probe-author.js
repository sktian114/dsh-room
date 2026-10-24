(() => {
  const body = String(document.body && document.body.innerText || '');
  const markers = body.match(/〔@[^〕]{1,40}〕/g) || [];
  return {
    authorState: document.documentElement.getAttribute('data-dsh-room-author'),
    authorChips: document.querySelectorAll('.dsh-room-author').length,
    markerCount: markers.length,
    markerSamples: markers.slice(0, 5),
    hasMarkChar: body.includes('〔@'),
    textLen: body.length,
    tail: body.replace(/\s+/g, ' ').slice(-320),
    markedCount: window.__dshRoomMarkedCount || 0,
    roomApiReady: typeof window.__dshRoomMarkPromptState,
  };
})()
