(async () => {
  const text = String(document.body.innerText || '');
  const targets = [
    '/plugins/??@sktian114/dsh-room/client.js&rev=bf4517935160',
    '/plugins/??@sktian114/dsh-room/client.js',
    '/plugins/??dsh-room/client.js',
  ];
  const results = [];
  for (const url of targets) {
    try {
      const response = await fetch(url, { credentials: 'include' });
      const body = await response.text();
      results.push({ url, status: response.status, length: body.length, head: body.slice(0, 160).replace(/\s+/g, ' ') });
    } catch (error) {
      results.push({ url, error: String(error).slice(0, 120) });
    }
  }
  return { bodyText: text.slice(0, 1200), results };
})()
