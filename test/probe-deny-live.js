// 房客页「发消息被拦」现场取证：记录所有 api/session/* 的 fetch（请求体 + 响应前 300 字），
// 再在输入框里发一句，最后把记录吐出来。配合 probe-run.mjs 使用。
(() => {
  const records = []
  const origFetch = window.fetch
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    const response = await origFetch.apply(this, arguments)
    if (/api\/(session|workspace|agentPresets)/.test(String(url))) {
      let body = ''
      try { body = typeof init?.body === 'string' ? init.body : '' } catch { body = '' }
      let text = ''
      try { text = await response.clone().text() } catch { text = '(读不到)' }
      let method = ''
      try { method = JSON.parse(body).method || '' } catch { method = '' }
      records.push({
        url: String(url),
        status: response.status,
        method,
        args: (() => { try { return JSON.stringify(JSON.parse(body).payload?.args || {}).slice(0, 200) } catch { return '' } })(),
        answer: text.slice(0, 300),
      })
    }
    return response
  }

  // 等界面起来后在输入框里发一句
  const send = () => {
    const box = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]')
    if (!box) return 'no-composer'
    const text = '取证消息 ' + Date.now()
    if (box.tagName === 'TEXTAREA' || box.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(box, text)
      box.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      box.focus()
      document.execCommand('insertText', false, text)
    }
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
    return 'sent'
  }

  return new Promise((resolve) => {
    setTimeout(() => {
      const sent = send()
      setTimeout(() => {
        const denyNode = [...document.querySelectorAll('*')].find((node) => (
          node.children.length === 0 && /房主没有开放|room\/blocked|已经被拦下/.test(node.textContent || '')
        ))
        resolve(JSON.stringify({
          sent,
          deny: denyNode ? denyNode.textContent.slice(0, 120) : '',
          denyFound: Boolean(denyNode),
          records,
        }, null, 2))
      }, 6000)
    }, 9000)
  })
})()
