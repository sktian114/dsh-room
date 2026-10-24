(async () => {
  const targets = [
    '/plugins/??@deepseek-ai/dsh-client-modules/client.js',
    '/plugins/??@deepseek-ai/dsh-client-ui-settings/client.js',
    '/plugins/??dsh-room/client.js',
    '/plugins/??@sktian114/dsh-room/client.js',
    '/plugins/??dsh-think-translate/client.js',
    '/plugins/??dsh-effort-slider/client.js',
  ];
  const out = [];
  for (const url of targets) {
    try {
      const response = await fetch(url, { credentials: 'include' });
      const text = await response.text();
      out.push({ url, status: response.status, length: text.length, head: text.slice(0, 80).replace(/\s+/g, ' ') });
    } catch (error) {
      out.push({ url, error: String(error).slice(0, 60) });
    }
  }
  return out;
})()
