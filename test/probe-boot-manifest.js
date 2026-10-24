(() => {
  const boot = window.__DSH_BOOT__ || null;
  const pick = (value) => {
    if (!value || typeof value !== 'object') return null;
    const rows = Array.isArray(value) ? value : (value.plugins || value.modules || value.rows || value.entries || null);
    if (!Array.isArray(rows)) return { keys: Object.keys(value).slice(0, 12) };
    return { count: rows.length, sample: rows.slice(0, 40).map((row) => String(row && (row.id || row.name || row.pkg || row.module) || JSON.stringify(row).slice(0, 40))) };
  };
  const matches = String(document.documentElement.outerHTML).match(/dsh-room/g);
  return {
    hasBoot: Boolean(boot),
    bootShape: pick(boot),
    htmlMentionsRoom: matches ? matches.length : 0,
    scriptSrcs: Array.from(document.scripts).map((s) => s.src).slice(0, 6),
    moduleLoaderKeys: (() => {
      const loader = window.__ModuleLoader__;
      if (!loader) return null;
      const keys = Object.keys(loader);
      const reg = loader.registry || loader.modules || loader.registered;
      return { keys, registered: reg && typeof reg === 'object' ? Object.keys(reg).filter((k) => /room/i.test(k)).slice(0, 5) : null, totalRegistered: reg && typeof reg === 'object' ? Object.keys(reg).length : null };
    })(),
  };
})()
