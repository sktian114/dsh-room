(() => {
  const out = { account: [], footer: null, sideTail: null, textOfFooterArea: null };
  const acct = Array.from(document.querySelectorAll('[class]')).filter((el) => /account|profile|userCard|signin|login|已登录/i.test(String(el.className) + String(el.textContent || '').slice(0, 0)));
  out.account = acct.slice(0, 6).map((el) => ({
    tag: el.tagName.toLowerCase(),
    cls: String(el.className).slice(0, 70),
    text: String(el.textContent || '').replace(/\s+/g, ' ').slice(0, 40),
    rect: (() => { const r = el.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) })(),
    html: el.outerHTML.slice(0, 600),
  }));
  const fa = document.querySelector('[class*=footerActions]');
  if (fa) {
    out.footer = {
      cls: String(fa.className),
      html: fa.outerHTML.slice(0, 800),
      parentCls: String(fa.parentElement && fa.parentElement.className).slice(0, 60),
      parentHtmlHead: fa.parentElement ? fa.parentElement.outerHTML.slice(0, 1200) : null,
    };
  }
  // 找到带「已登录」文字的最小节点
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = null;
  while (walker.nextNode()) {
    const t = String(walker.currentNode.nodeValue || '').trim();
    if (t.indexOf('已登录') >= 0) { node = walker.currentNode.parentElement; break }
  }
  if (node) {
    out.loginNode = {
      tag: node.tagName.toLowerCase(),
      cls: String(node.className).slice(0, 70),
      text: String(node.textContent || '').replace(/\s+/g, ' ').slice(0, 60),
      outer3: (() => { let el = node; for (let i = 0; i < 3 && el.parentElement; i += 1) el = el.parentElement; return { cls: String(el.className).slice(0, 70), html: el.outerHTML.slice(0, 1500) } })(),
      chain: (() => { const rows = []; let el = node; for (let i = 0; i < 5 && el; i += 1) { rows.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60) }); el = el.parentElement } return rows })(),
    };
  }
  return out;
})()
