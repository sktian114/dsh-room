(() => {
  const boot = window.__DSH_BOOT__ || {};
  const entries = Array.isArray(boot.entries) ? boot.entries : [];
  return {
    rev: boot.rev,
    count: entries.length,
    names: entries.map((entry) => String((entry && entry.id) || '')),
  };
})()
