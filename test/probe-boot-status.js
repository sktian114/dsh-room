/**
 * 只读：看网页启动清单里每个插件条目的状态，以及加载器记下的错误。
 * 用途：用户看到「Failed to load plugins / @deepseek-ai/dsh-experimental-client-ui-cot-translation:
 * loading」时，判断到底是谁的锅（是我们 dsh-room 还是 DSH 自带的实验插件）。
 *
 * 用法：node test/probe-run.mjs --url=http://127.0.0.1:56155/ --wait=9000 \
 *        --js=test/probe-boot-status.js --port=9480
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = { errors: [] }
  try {
    // 先挂上错误收集（尽量早；页面已经跑起来了，能抓到的就先抓）
    await sleep(500)
    const boot = window.__DSH_BOOT__ || null
    out.hasBoot = Boolean(boot)
    if (boot) {
      out.keys = Object.keys(boot)
      const entries = Array.isArray(boot.entries) ? boot.entries : []
      out.entryCount = entries.length
      out.entries = entries.map((entry) => ({
        id: entry.id,
        url: String(entry.url || "").slice(0, 60),
        status: entry.status || entry.state || "",
        error: entry.error ? String(entry.error && entry.error.message ? entry.error.message : entry.error).slice(0, 120) : "",
      })).filter((entry) => /room|cot-translation/.test(entry.id || ""))
    }
    // 加载器自己记的失败
    const loader = window.__ModuleLoader__ || null
    out.loaderKeys = loader ? Object.keys(loader) : null
    // 页面上的失败面板文本
    const body = String(document.body ? document.body.innerText : "")
    out.panelHead = body.slice(0, 400)
    out.hasFailPanel = /Failed to load plugins/.test(body)
    // DOM 里带 error 的节点
    out.errorNodes = [...document.querySelectorAll("[data-error], [class*=error], [class*=fail]")]
      .slice(0, 8)
      .map((el) => ({
        cls: String(el.className || "").slice(0, 50),
        text: String(el.textContent || "").trim().slice(0, 120),
      }))
    // 我们自己的模块有没有挂上
    out.roomLoaded = Boolean(loader && typeof loader.load === "function")
    out.ourChipHook = typeof window.__dshRoomPaintAuthors === "function"
  } catch (error) {
    out.errors.push(String(error && error.message ? error.message : error))
  }
  return JSON.stringify(out, null, 2)
})()
