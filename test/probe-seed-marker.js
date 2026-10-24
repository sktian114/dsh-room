(() => {
  // 只改这个一次性浏览器配置里的会话缓存（不是宿主会话文件），
  // 给一条用户消息前面种上作者标记，用来验收「胶囊会不会渲染」。
  const NL = String.fromCharCode(10);
  const key = Object.keys(window.localStorage).find((k) => k.indexOf('dsh.conversation.session-') === 0);
  if (!key) return { patched: false, reason: 'no store' };
  const raw = window.localStorage.getItem(key);
  const needle = '你好，我想要和你玩一个文字';
  const at = raw.indexOf(needle);
  if (at < 0) return { patched: false, reason: 'text not found', key, sample: raw.slice(0, 400) };
  const patched = raw.slice(0, at) + '〔@房客验收〕' + NL + raw.slice(at);
  window.localStorage.setItem(key, patched);
  return { patched: true, key, length: { before: raw.length, after: patched.length }, markerAt: patched.indexOf('〔@房客验收〕') };
})()
