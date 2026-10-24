(() => {
  const editor = document.querySelector('[contenteditable="true"]');
  const composer = editor ? editor.closest('[class*="GRgSLq_"]') || editor.parentElement.parentElement : null;
  const buttons = Array.from(document.querySelectorAll('button')).map((b) => ({
    label: String(b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 12),
    disabled: b.disabled,
    ariaDisabled: b.getAttribute('aria-disabled'),
    cls: String(b.className).slice(0, 40),
  })).filter((b) => b.label);
  const attrs = (el) => el ? Array.from(el.attributes).map((a) => a.name + '=' + String(a.value).slice(0, 30)) : null;
  return {
    editor: editor ? { tag: editor.tagName, attrs: attrs(editor), text: String(editor.textContent || '').slice(0, 40) } : null,
    composerCls: composer ? String(composer.className).slice(0, 60) : null,
    composerAttrs: attrs(composer),
    buttons: buttons.slice(0, 14),
    denyNodes: Array.from(document.querySelectorAll('[data-dsh-room-deny], .dsh-room-deny')).map((el) => String(el.textContent || '').slice(0, 60)),
    html: composer ? composer.outerHTML.slice(0, 900) : null,
  };
})()
