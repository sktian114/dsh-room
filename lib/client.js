/**
 * dsh-room —— 浏览器半边（手写 ModuleLoader bundle，无需构建）
 *
 * 输入框右侧一枚「联机」按钮，点开是贴着按钮弹出的面板：
 *   · 房主：建房 / 邀请地址 / 成员 / 工作区 / 停止
 *   · 访客：输入 172.16.1.130:8787 加入 / 成员 / 工作区 / 打开房主工作台
 *
 * 视觉与交互对齐 DSH 自身设计语言：
 *   · 颜色、圆角、字体、阴影全部优先取 DSH 的 --dsw-* / --dsw-alias-* token，
 *     浅色 / 深色主题随宿主自动切换；取不到时退回中性色。
 *   · 面板贴着「联机」按钮向上弹出，点外部 / Esc 关闭，焦点、hover、focus ring
 *     都按 DSH 的交互习惯处理。
 *   · 不依赖 react-dom，用 position:fixed 渲染在插槽树里。
 */
window.__ModuleLoader__.load({
  id: "dsh-room",
  factory: function (require) {
    var module = { exports: {} };

    var reactModule = require("react");
    var React = reactModule && reactModule.createElement ? reactModule : (reactModule && reactModule.default);
    if (!React || !React.createElement) {
      try { console.error("[dsh-room] React 不可用，联机面板不会出现"); } catch (ignore) { /* 忽略 */ }
      module.exports = { apply: function () {}, inject: ["slots"] };
      return module.exports;
    }

    var h = React.createElement;
    var Fragment = React.Fragment;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    var STORAGE_GUEST = "dsh-room.guest";
    var STORAGE_NAME = "dsh-room.name";
    var DEFAULT_PORT = "8787";
    // React 在开发构建下会把 effect 跑两遍（StrictMode）；自动加入只能试一次，
    // 否则房主会看到同一个手机出现两条「访客」记录。
    var autoJoinAttempted = false;

    /* ───────────────────────── 图标 ───────────────────────── */

    // 24×24 线性图标（描边风格），和 DSH 自身的图标语言一致。
    var FILLED_ICONS = { crown: true, play: true };
    var ICONS = {
      users: [["path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" }], ["circle", { cx: 9, cy: 7, r: 4 }], ["path", { d: "M22 21v-2a4 4 0 0 0-3-3.87" }], ["path", { d: "M16 3.13a4 4 0 0 1 0 7.75" }]],
      x: [["path", { d: "M18 6 6 18" }], ["path", { d: "M6 6l12 12" }]],
      copy: [["rect", { x: 9, y: 9, width: 13, height: 13, rx: 2 }], ["path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }]],
      check: [["path", { d: "M20 6 9 17l-5-5" }]],
      refresh: [["path", { d: "M21 12a9 9 0 1 1-3-6.7L21 8" }], ["path", { d: "M21 3v5h-5" }]],
      stop: [["rect", { x: 6, y: 6, width: 12, height: 12, rx: 1.5 }]],
      play: [["path", { d: "m7 4 13 8-13 8z" }]],
      folder: [["path", { d: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.5l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z" }]],
      file: [["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" }], ["path", { d: "M14 2v6h6" }]],
      chevron: [["path", { d: "m9 18 6-6-6-6" }]],
      shield: [["path", { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" }]],
      globe: [["circle", { cx: 12, cy: 12, r: 10 }], ["path", { d: "M2 12h20" }], ["path", { d: "M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20" }]],
      link: [["path", { d: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" }], ["path", { d: "M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" }]],
      wifi: [["path", { d: "M5 12.55a11 11 0 0 1 14 0" }], ["path", { d: "M8.5 16.1a6 6 0 0 1 7 0" }], ["path", { d: "M12 20h.01" }]],
      logout: [["path", { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" }], ["path", { d: "m16 17 5-5-5-5" }], ["path", { d: "M21 12H9" }]],
      clock: [["circle", { cx: 12, cy: 12, r: 10 }], ["path", { d: "M12 7v5l3 2" }]],
      crown: [["path", { d: "m2 7 4 4 6-7 6 7 4-4-2 12H4z" }]],
      info: [["circle", { cx: 12, cy: 12, r: 10 }], ["path", { d: "M12 16v-4" }], ["path", { d: "M12 8h.01" }]],
      arrow: [["path", { d: "M5 12h14" }], ["path", { d: "m13 6 6 6-6 6" }]],
      external: [["path", { d: "M15 3h6v6" }], ["path", { d: "M10 14 21 3" }], ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }]],
      door: [["path", { d: "M13 4h3a2 2 0 0 1 2 2v14" }], ["path", { d: "M2 20h20" }], ["path", { d: "M13 20V4" }], ["path", { d: "M9 12v.01" }]],
      alert: [["path", { d: "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" }], ["path", { d: "M12 9v4" }], ["path", { d: "M12 17h.01" }]],
      chat: [["path", { d: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H7l-4 3v-6.2A8.5 8.5 0 0 1 12.5 3h.5a8 8 0 0 1 8 8z" }]],
      send: [["path", { d: "m22 2-7 20-4-9-9-4z" }], ["path", { d: "M22 2 11 13" }]],
      back: [["path", { d: "m15 18-6-6 6-6" }]],
      trash: [["path", { d: "M3 6h18" }], ["path", { d: "M8 6V4h8v2" }], ["path", { d: "M19 6l-1 14H6L5 6" }]],
      plus: [["path", { d: "M12 5v14" }], ["path", { d: "M5 12h14" }]],
    };

    function Icon(props) {
      var spec = ICONS[props.name] || [];
      var filled = Boolean(FILLED_ICONS[props.name]);
      var children = spec.map(function (item, index) {
        return h(item[0], Object.assign({ key: index }, item[1]));
      });
      var attrs = {
        className: "dsh-room-i" + (props.className ? " " + props.className : ""),
        viewBox: "0 0 24 24",
        width: props.size || 14,
        height: props.size || 14,
        fill: filled ? "currentColor" : "none",
        stroke: filled ? "none" : "currentColor",
        strokeWidth: props.stroke || 1.7,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        focusable: "false",
      };
      if (props.attrs) Object.assign(attrs, props.attrs);
      return h("svg", attrs, children);
    }

    /* ───────────────────────── 样式 ───────────────────────── */

    function ensureStyle() {
      try {
        if (document.getElementById("dsh-room-style")) return;
        var style = document.createElement("style");
        style.id = "dsh-room-style";
        style.textContent = [
          ".dsh-room-panel,.dsh-room-panel *{box-sizing:border-box}",
          ".dsh-room-i{display:block;flex:none}",
          /* ── 启动按钮：尺寸/圆角/边框对齐 DSH 的小号按钮 ── */
          ".dsh-room-launch{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;",
          "border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.09));border-radius:8px;background:transparent;",
          "color:var(--dsw-alias-label-secondary,#5b6270);",
          "font:12px/18px var(--dsw-font-family,system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif);",
          "cursor:pointer;transition:background .12s,color .12s,border-color .12s}",
          ".dsh-room-launch:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(15,17,21,.05));",
          "color:var(--dsw-alias-label-primary,#0f1115)}",
          ".dsh-room-launch[data-open=true],.dsh-room-launch[data-live=true]{",
          "background:var(--dsw-alias-interactive-bg-active,rgba(15,17,21,.085));",
          "color:var(--dsw-alias-label-primary,#0f1115);border-color:var(--dsw-alias-border-l3,rgba(0,0,0,.13))}",
          ".dsh-room-launch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:2px}",
          ".dsh-room-launch .live-dot{width:6px;height:6px;border-radius:50%;",
          "background:var(--dsw-alias-state-success-primary,#1fa855);",
          "box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,#1fa855) 18%,transparent)}",
          /* ── 面板 ── */
          /* ── 共用视觉变量：房间面板与聊天面板共享同一套 DSH 设计令牌 ── */
          ".dsh-room-panel,.dsh-room-chatpanel{",
          "--r-font:var(--dsw-font-family,system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif);",
          "--r-mono:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Consolas,'Cascadia Code',monospace);",
          "--r-accent:var(--dsw-alias-state-business-primary,#4176e6);",
          "--r-success:var(--dsw-alias-state-success-primary,#1fa855);",
          "--r-danger:var(--dsw-alias-state-error-primary,#d92d20);",
          "--r-warn:var(--dsw-alias-state-warn-primary,#f59e0b);",
          "--r-text:var(--dsw-alias-label-primary,#0f1115);",
          "--r-text-2:var(--dsw-alias-label-secondary,#5b6270);",
          "--r-text-3:var(--dsw-alias-label-tertiary,#8a919e);",
          "--r-border:var(--dsw-alias-border-l2,rgba(0,0,0,.09));",
          "--r-border-strong:var(--dsw-alias-border-l3,rgba(0,0,0,.13));",
          "--r-surface:var(--dsw-alias-bg-layer-2,#fff);",
          "--r-base:var(--dsw-alias-bg-base,#fff);",
          "--r-hover:var(--dsw-alias-interactive-bg-hover,rgba(15,17,21,.05));",
          "--r-press:var(--dsw-alias-interactive-bg-active,rgba(15,17,21,.085));",
          "--r-fill:color-mix(in srgb,var(--r-text) 4%,transparent);",
          "--r-fill-2:color-mix(in srgb,var(--r-text) 6.5%,transparent);",
          "--r-shadow:var(--dsw-elevation-prominent,0 0 0 .5px rgba(0,0,0,.12),0 16px 40px rgba(0,0,0,.14),0 2px 8px rgba(0,0,0,.05));",
          "--r-radius:var(--dsw-radius-lg,16px);",
          "--r-radius-md:var(--dsw-radius-md,12px);",
          "--r-radius-sm:var(--dsw-radius-sm,8px);",
          "color-scheme:light dark;color:var(--r-text);background:var(--r-surface);",
          "border:0;box-shadow:var(--r-shadow);font:13px/20px var(--r-font)}",
          /* ── 房间面板（房主 / 访客）── */
          ".dsh-room-panel{position:fixed;right:var(--room-right,16px);bottom:var(--room-bottom,72px);",
          "width:384px;max-width:calc(100vw - 16px);max-height:var(--room-maxh,min(72vh,640px));display:flex;flex-direction:column;",
          "z-index:2147483000;overflow:hidden;border-radius:var(--r-radius);animation:dsh-room-in .18s cubic-bezier(.2,.8,.3,1)}",
          "@keyframes dsh-room-in{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}",
          /* 头部 */
          ".dsh-room-head{display:flex;align-items:flex-start;gap:10px;padding:14px 14px 0;flex:none}",
          ".dsh-room-heading{flex:1;min-width:0}",
          ".dsh-room-title{font-size:14px;line-height:20px;font-weight:600;letter-spacing:.01em}",
          ".dsh-room-sub{margin-top:1px;font-size:11.5px;line-height:16px;color:var(--r-text-3)}",
          ".dsh-room-iconbtn{flex:none;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;",
          "border:0;border-radius:7px;background:transparent;color:var(--r-text-3);cursor:pointer;transition:background .12s,color .12s}",
          ".dsh-room-iconbtn:hover{background:var(--r-hover);color:var(--r-text)}",
          ".dsh-room-iconbtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--r-accent));outline-offset:1px}",
          /* 分段标签 */
          ".dsh-room-tabs{position:relative;display:grid;grid-template-columns:1fr 1fr;gap:2px;margin:12px 14px 0;padding:4px;",
          "border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-interactive-bg-hover,var(--r-fill));flex:none}",
          ".dsh-room-tab-indicator{position:absolute;top:4px;left:4px;width:calc((100% - 8px - 2px) / 2);height:calc(100% - 8px);",
          "border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,var(--r-base));",
          "box-shadow:var(--dsw-elevation-soft,0 4px 16px rgba(0,0,0,.05));pointer-events:none;",
          "transform:translateX(calc(var(--tab-index,0) * (100% + 2px)));transition:transform .16s ease}",
          ".dsh-room-tab{position:relative;z-index:1;height:28px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--r-text-2);",
          "font:500 13px/20px var(--r-font);cursor:pointer;transition:color .12s}",
          ".dsh-room-tab:hover{color:var(--r-text)}",
          ".dsh-room-tab[data-active=true]{color:var(--r-text)}",
          ".dsh-room-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--r-accent));outline-offset:-1px}",
          /* 内容区 */
          ".dsh-room-body{flex:1;min-height:0;overflow:auto;padding:12px 14px 14px;overscroll-behavior:contain}",
          ".dsh-room-body::-webkit-scrollbar{width:10px}",
          ".dsh-room-body::-webkit-scrollbar-thumb{background:var(--dsw-scrollbar-thumb,rgba(0,0,0,.16));",
          "border:3px solid transparent;background-clip:padding-box;border-radius:999px}",
          /* 状态卡 */
          ".dsh-room-status{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;",
          "background:var(--r-fill);border:.5px solid var(--r-border)}",
          ".dsh-room-pulse{position:relative;flex:none;width:8px;height:8px;border-radius:50%;background:var(--r-success)}",
          ".dsh-room-pulse:after{content:'';position:absolute;inset:-3px;border-radius:50%;",
          "border:1px solid var(--r-success);opacity:.5;animation:dsh-room-pulse 2.2s ease-out infinite}",
          ".dsh-room-pulse.off{background:var(--r-text-3)}.dsh-room-pulse.off:after{display:none}",
          "@keyframes dsh-room-pulse{0%{transform:scale(.7);opacity:.55}70%{transform:scale(1.6);opacity:0}100%{opacity:0}}",
          ".dsh-room-status-main{flex:1;min-width:0}",
          ".dsh-room-status-title{font-size:13px;line-height:18px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
          ".dsh-room-status-sub{margin-top:1px;font-size:11.5px;line-height:15px;color:var(--r-text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
          /* 徽标 */
          ".dsh-room-pill{flex:none;display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;",
          "border-radius:6px;font:11px/1 var(--r-font);background:var(--r-fill-2);color:var(--r-text-2);",
          "border:.5px solid var(--r-border)}",
          ".dsh-room-pill.warn{color:var(--r-warn);background:color-mix(in srgb,var(--r-warn) 12%,transparent);",
          "border-color:color-mix(in srgb,var(--r-warn) 28%,transparent)}",
          ".dsh-room-pill.ok{color:var(--r-success);background:color-mix(in srgb,var(--r-success) 11%,transparent);",
          "border-color:color-mix(in srgb,var(--r-success) 26%,transparent)}",
          ".dsh-room-pill.mode-readonly{color:var(--r-text-2);background:var(--r-fill-2)}",
          ".dsh-room-pill.mode-write{color:var(--r-accent);background:color-mix(in srgb,var(--r-accent) 12%,transparent);",
          "border-color:color-mix(in srgb,var(--r-accent) 30%,transparent)}",
          ".dsh-room-pill.mode-full{color:var(--r-warn);background:color-mix(in srgb,var(--r-warn) 12%,transparent);",
          "border-color:color-mix(in srgb,var(--r-warn) 28%,transparent)}",
          ".dsh-room-policy-row{display:flex;align-items:center;gap:8px;margin:6px 0}",
          ".dsh-room-policy-row .dsh-room-input{flex:1;min-width:0}",
          ".dsh-room-policy-row .dsh-room-select{flex:none;width:88px}",
          /* ── 自定义单选下拉（替代原生 select）── */
          ".dsh-room-sel{position:relative;flex:none;min-width:0}",
          ".dsh-room-sel.wide{width:100%}",
          ".dsh-room-sel-trigger{display:flex;align-items:center;gap:6px;width:100%;height:34px;padding:0 8px 0 10px;",
          "border:.5px solid var(--r-border-strong);border-radius:9px;background:var(--r-base);color:var(--r-text);",
          "font:13px/20px var(--r-font);text-align:left;cursor:pointer;transition:border-color .12s,box-shadow .12s}",
          ".dsh-room-sel-trigger:hover{border-color:var(--r-text-3)}",
          ".dsh-room-sel-trigger:focus-visible{outline:none;border-color:var(--r-accent);",
          "box-shadow:0 0 0 3px color-mix(in srgb,var(--r-accent) 18%,transparent)}",
          ".dsh-room-sel[data-open=true] .dsh-room-sel-trigger{border-color:var(--r-accent);",
          "box-shadow:0 0 0 3px color-mix(in srgb,var(--r-accent) 16%,transparent)}",
          ".dsh-room-sel-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
          ".dsh-room-sel-label.ph{color:var(--r-text-3)}",
          ".dsh-room-sel-chev{flex:none;display:inline-flex;align-items:center;color:var(--r-text-3);transition:transform .16s ease}",
          ".dsh-room-sel[data-open=true] .dsh-room-sel-chev{transform:rotate(-90deg)}",
          ".dsh-room-sel.sm .dsh-room-sel-trigger{height:26px;padding:0 6px 0 8px;font:11.5px/16px var(--r-font);border-radius:7px}",
          ".dsh-room-sel.sm .dsh-room-sel-chev svg{width:12px;height:12px}",
          ".dsh-room-sel-pop{position:fixed;z-index:2147483002;padding:4px;border-radius:10px;",
          "background:var(--r-base);border:.5px solid var(--r-border);box-shadow:var(--r-shadow);",
          "max-height:240px;overflow:auto;overscroll-behavior:contain;animation:dsh-room-menu .12s ease-out}",
          "@keyframes dsh-room-menu{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}",
          ".dsh-room-sel-opt{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:7px;",
          "font:12.5px/18px var(--r-font);color:var(--r-text-2);cursor:pointer;white-space:nowrap}",
          ".dsh-room-sel-opt[data-active=true]{background:var(--r-hover);color:var(--r-text)}",
          ".dsh-room-sel-opt[data-selected=true]{color:var(--r-text);font-weight:500}",
          ".dsh-room-sel-tick{flex:none;display:inline-flex;width:14px;height:14px;color:var(--r-accent);opacity:0}",
          ".dsh-room-sel-opt[data-selected=true] .dsh-room-sel-tick{opacity:1}",
          /* ── 选择文件夹（代替手输路径）── */
          ".dsh-room-pickrow{display:flex;align-items:center;gap:6px;margin-top:6px}",
          ".dsh-room-pickpath{flex:1;min-width:0;display:flex;align-items:center;gap:6px;height:34px;padding:0 9px;",
          "border:.5px dashed var(--r-border-strong);border-radius:9px;background:var(--r-fill);",
          "font:11.5px/16px var(--r-mono);color:var(--r-text-2)}",
          ".dsh-room-pickpath span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
          ".dsh-room-pickpath .ph{color:var(--r-text-3);font-family:var(--r-font);font-size:12px}",
          /* ── 拖动 ── */
          ".dsh-room-head,.dsh-room-chathead{cursor:grab;touch-action:none}",
          ".dsh-room-panel[data-dragging=true],.dsh-room-chatpanel[data-dragging=true]{animation:none}",
          ".dsh-room-panel[data-dragging=true] .dsh-room-head,",
          ".dsh-room-chatpanel[data-dragging=true] .dsh-room-chathead{cursor:grabbing}",
          ".dsh-room-panel[data-dragging=true],.dsh-room-panel[data-dragging=true] *,",
          ".dsh-room-chatpanel[data-dragging=true],.dsh-room-chatpanel[data-dragging=true] *{user-select:none}",
          ".dsh-room-policy-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
          "font:11px/16px var(--r-mono,monospace);color:var(--r-text-3)}",
          /* 区块标题 */
          ".dsh-room-section{display:flex;align-items:center;gap:8px;margin:15px 0 7px}",
          ".dsh-room-section:first-child{margin-top:0}",
          ".dsh-room-section-title{font-size:11.5px;line-height:16px;font-weight:500;color:var(--r-text-3);letter-spacing:.02em}",
          ".dsh-room-count{flex:none;font-size:10.5px;line-height:15px;color:var(--r-text-3);padding:0 5px;border-radius:5px;background:var(--r-fill)}",
          ".dsh-room-section-spacer{flex:1}",
          /* 文本按钮 */
          ".dsh-room-ghost{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 7px;margin:-3px -3px -3px 0;",
          "border:0;border-radius:6px;background:transparent;color:var(--r-accent);font:11.5px/16px var(--r-font);",
          "cursor:pointer;transition:background .12s}",
          ".dsh-room-ghost:hover{background:color-mix(in srgb,var(--r-accent) 9%,transparent)}",
          ".dsh-room-ghost:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--r-accent));outline-offset:1px}",
          /* 地址 */
          ".dsh-room-addrs{display:flex;flex-direction:column;gap:6px}",
          ".dsh-room-addr{display:flex;align-items:center;gap:8px;width:100%;height:36px;padding:0 9px;",
          "border:.5px solid var(--r-border);border-radius:9px;background:var(--r-fill);color:var(--r-text);",
          "font:12px/1 var(--r-mono);text-align:left;cursor:pointer;transition:border-color .12s,background .12s}",
          ".dsh-room-addr:hover{background:var(--r-fill-2);border-color:color-mix(in srgb,var(--r-accent) 35%,var(--r-border))}",
          ".dsh-room-addr:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--r-accent));outline-offset:1px}",
          ".dsh-room-addr-ico{flex:none;display:inline-flex;color:var(--r-text-3)}",
          ".dsh-room-addr-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
          ".dsh-room-addr-tag{flex:none;font:10px/1 var(--r-font);color:var(--r-text-3);padding:2px 5px;border-radius:4px;background:var(--r-fill-2)}",
          ".dsh-room-addr-copy{flex:none;display:inline-flex;color:var(--r-text-3)}",
          ".dsh-room-addr[data-copied=true] .dsh-room-addr-copy{color:var(--r-success)}",
          /* 成员 */
          ".dsh-room-members{display:flex;flex-direction:column;gap:1px}",
          ".dsh-room-member{display:flex;align-items:center;gap:9px;height:34px;padding:0 4px;border-radius:8px}",
          ".dsh-room-member:hover{background:var(--r-fill)}",
          ".dsh-room-avatar{position:relative;flex:none;width:24px;height:24px;border-radius:50%;display:inline-flex;",
          "align-items:center;justify-content:center;font:600 11px/1 var(--r-font);",
          "background:hsl(var(--hue,210) 70% 55% / .15);color:hsl(var(--hue,210) 62% 38%)}",
          "[data-ds-dark-theme] .dsh-room-avatar{background:hsl(var(--hue,210) 70% 60% / .22);color:hsl(var(--hue,210) 78% 76%)}",
          ".dsh-room-avatar.host{box-shadow:0 0 0 1.5px color-mix(in srgb,var(--r-warn) 45%,transparent)}",
          ".dsh-room-avatar .crown{position:absolute;right:-3px;top:-3px;color:var(--r-warn)}",
          ".dsh-room-mname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;line-height:18px;font-weight:400}",
          ".dsh-room-mmeta{flex:none;font-size:11px;line-height:16px;color:var(--r-text-3)}",
          ".dsh-room-kick{flex:none;display:none;width:22px;height:22px;border:0;border-radius:6px;background:transparent;",
          "color:var(--r-text-3);cursor:pointer;align-items:center;justify-content:center;padding:0}",
          ".dsh-room-member:hover .dsh-room-kick{display:inline-flex}",
          ".dsh-room-kick:hover{background:color-mix(in srgb,var(--r-danger) 12%,transparent);color:var(--r-danger)}",
          ".dsh-room-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:16px 10px;",
          "border:.5px dashed var(--r-border-strong);border-radius:10px;color:var(--r-text-3);font-size:11.5px;line-height:17px;text-align:center}",
          ".dsh-room-empty svg{opacity:.55}",
          /* 工作区 */
          ".dsh-room-path{display:flex;align-items:center;gap:6px;margin-bottom:7px;font:11.5px/16px var(--r-mono);color:var(--r-text-3);overflow:hidden}",
          ".dsh-room-path span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}",
          ".dsh-room-tree{border:.5px solid var(--r-border);border-radius:10px;background:color-mix(in srgb,var(--r-text) 2.5%,transparent);max-height:224px;overflow:auto;padding:3px}",
          ".dsh-room-tree::-webkit-scrollbar{width:9px}",
          ".dsh-room-tree::-webkit-scrollbar-thumb{background:var(--dsw-scrollbar-thumb,rgba(0,0,0,.16));border:3px solid transparent;background-clip:padding-box;border-radius:999px}",
          ".dsh-room-node{min-width:0}",
          ".dsh-room-row{display:flex;align-items:center;gap:6px;height:27px;padding:0 6px;border-radius:6px;",
          "font-size:12.5px;line-height:18px;white-space:nowrap;color:var(--r-text-2)}",
          ".dsh-room-row.dir{cursor:pointer}",
          ".dsh-room-row:hover{background:var(--r-hover);color:var(--r-text)}",
          ".dsh-room-caret{flex:none;width:12px;height:12px;color:var(--r-text-3);transition:transform .13s}",
          ".dsh-room-caret[data-open=true]{transform:rotate(90deg)}",
          ".dsh-room-ico{flex:none;display:inline-flex;color:var(--r-text-3)}",
          ".dsh-room-ico.folder{color:color-mix(in srgb,var(--r-accent) 70%,var(--r-text-3))}",
          ".dsh-room-nm{overflow:hidden;text-overflow:ellipsis}",
          ".dsh-room-kids{margin-left:12px;padding-left:8px;border-left:.5px solid var(--r-border)}",
          ".dsh-room-muted{font-size:11.5px;line-height:17px;color:var(--r-text-3);padding:3px 2px}",
          ".dsh-room-skel{height:9px;border-radius:4px;background:linear-gradient(90deg,var(--r-fill) 25%,var(--r-fill-2) 40%,var(--r-fill) 55%);background-size:200% 100%;animation:dsh-room-shimmer 1.2s infinite}",
          "@keyframes dsh-room-shimmer{from{background-position:120% 0}to{background-position:-40% 0}}",
          ".dsh-room-skeleton{display:flex;flex-direction:column;gap:8px;padding:6px 2px}",
          /* 提示 */
          ".dsh-room-note{display:flex;align-items:flex-start;gap:7px;margin-top:12px;padding:9px 10px;border-radius:9px;",
          "background:color-mix(in srgb,var(--r-warn) 8%,transparent);border:.5px solid color-mix(in srgb,var(--r-warn) 20%,transparent);",
          "color:var(--r-text-2);font-size:11px;line-height:16px}",
          ".dsh-room-note svg{margin-top:1px;color:var(--r-warn)}",
          ".dsh-room-note.info{background:var(--r-fill);border-color:var(--r-border);color:var(--r-text-3)}",
          ".dsh-room-note.info svg{color:var(--r-text-3)}",
          /* 表单 */
          ".dsh-room-field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}",
          ".dsh-room-label{display:flex;align-items:center;gap:6px;font-size:11.5px;line-height:16px;color:var(--r-text-2)}",
          ".dsh-room-label .hint{color:var(--r-text-3)}",
          ".dsh-room-input,.dsh-room-select{width:100%;height:34px;padding:0 10px;border:.5px solid var(--r-border-strong);",
          "border-radius:8px;background:var(--r-base);color:var(--r-text);font:13px/1 var(--r-font);",
          "transition:border-color .12s,box-shadow .12s}",
          ".dsh-room-select{appearance:none;-webkit-appearance:none;padding-right:28px;",
          "background-image:linear-gradient(45deg,transparent 50%,var(--r-text-3) 50%),linear-gradient(135deg,var(--r-text-3) 50%,transparent 50%);",
          "background-position:calc(100% - 14px) 14px,calc(100% - 9px) 14px;background-size:5px 5px,5px 5px;background-repeat:no-repeat}",
          ".dsh-room-input::placeholder{color:var(--r-text-3);opacity:.85}",
          ".dsh-room-input:hover,.dsh-room-select:hover{border-color:var(--r-text-3)}",
          ".dsh-room-input:focus,.dsh-room-select:focus{outline:none;border-color:var(--r-accent);",
          "box-shadow:0 0 0 3px color-mix(in srgb,var(--r-accent) 16%,transparent)}",
          ".dsh-room-row2{display:grid;grid-template-columns:1fr 1fr;gap:8px}",
          ".dsh-room-join-input{height:38px;font:12.5px/1 var(--r-mono);letter-spacing:.01em}",
          ".dsh-room-error{display:flex;align-items:flex-start;gap:6px;margin-top:8px;padding:8px 9px;border-radius:8px;",
          "background:color-mix(in srgb,var(--r-danger) 9%,transparent);border:.5px solid color-mix(in srgb,var(--r-danger) 22%,transparent);",
          "color:var(--r-danger);font-size:11.5px;line-height:16px}",
          /* 底部 */
          ".dsh-room-foot{display:flex;gap:8px;padding:10px 14px 12px;border-top:.5px solid var(--r-border);",
          "background:color-mix(in srgb,var(--r-text) 1.5%,transparent);flex:none}",
          ".dsh-room-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;",
          "border:.5px solid var(--r-border-strong);border-radius:8px;background:transparent;color:var(--r-text);",
          "font:12.5px/18px var(--r-font);cursor:pointer;transition:background .12s,border-color .12s,color .12s,opacity .12s}",
          ".dsh-room-btn:hover{background:var(--r-hover)}.dsh-room-btn:active{background:var(--r-press)}",
          ".dsh-room-btn:disabled{opacity:.5;cursor:default}",
          ".dsh-room-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--r-accent));outline-offset:1px}",
          ".dsh-room-btn.grow{flex:1}",
          ".dsh-room-btn.primary{background:var(--dsw-alias-brand-primary,#101114);",
          "color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent;font-weight:500}",
          ".dsh-room-btn.primary:hover{opacity:.9}",
          ".dsh-room-btn.danger{color:var(--r-danger);border-color:color-mix(in srgb,var(--r-danger) 26%,transparent)}",
          ".dsh-room-btn.danger:hover{background:color-mix(in srgb,var(--r-danger) 9%,transparent)}",
          ".dsh-room-btn.ghost{border-color:transparent;color:var(--r-text-2)}",
          ".dsh-room-btn.ghost:hover{background:var(--r-hover);color:var(--r-text)}",
          ".dsh-room-btn.wide{flex:1}.dsh-room-cta{height:34px;width:100%;margin-top:2px}",
          ".dsh-room-btn.sm{height:28px;padding:0 9px;font-size:12px;gap:5px}",
          ".dsh-room-pickpath:hover{border-color:var(--r-accent);background:color-mix(in srgb,var(--r-accent) 6%,transparent)}",
          ".dsh-room-pickpath:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--r-accent));outline-offset:1px}",
          ".dsh-room-pick-hint{flex:none;font:11px/16px var(--r-font);color:var(--r-text-3);margin-top:6px}",
          /* toast */
          ".dsh-room-toast{position:absolute;left:50%;bottom:56px;transform:translate(-50%,4px);z-index:5;",
          "display:flex;align-items:center;gap:6px;height:30px;padding:0 11px;border-radius:9px;",
          "background:var(--dsw-alias-brand-primary,#101114);color:var(--dsw-alias-label-primary-foreground,#fff);",
          "font:12px/18px var(--r-font);box-shadow:0 8px 24px rgba(0,0,0,.28);opacity:0;pointer-events:none;",
          "transition:opacity .16s,transform .16s}",
          ".dsh-room-toast[data-show=true]{opacity:1;transform:translate(-50%,0)}",
          /* ── 聊天面板：右侧横向长方形，左列群列表（微信式）+ 右侧消息流 ── */
          ".dsh-room-chatpanel{position:fixed;right:24px;top:50%;transform:translateY(-50%);",
          "width:min(760px,calc(100vw - 48px));height:min(452px,calc(100vh - 128px));",
          "display:grid;grid-template-columns:198px minmax(0,1fr);overflow:hidden;",
          "z-index:2147483001;border-radius:var(--r-radius);animation:dsh-room-chat-in .18s cubic-bezier(.2,.8,.3,1)}",
          "@keyframes dsh-room-chat-in{from{opacity:0;transform:translateY(-50%) translateX(12px) scale(.99)}",
          "to{opacity:1;transform:translateY(-50%) translateX(0) scale(1)}}",
          /* 左列：群列表 */
          ".dsh-room-chatlist{display:flex;flex-direction:column;min-height:0;min-width:0;",
          "border-right:.5px solid var(--r-border);background:color-mix(in srgb,var(--r-text) 2.5%,transparent)}",
          ".dsh-room-chatlist-head{display:flex;align-items:center;gap:8px;padding:12px 12px 8px;flex:none}",
          ".dsh-room-chatlist-title{font-size:12.5px;line-height:17px;font-weight:600;letter-spacing:.01em}",
          ".dsh-room-chatlist-sub{margin-top:1px;font-size:10.5px;line-height:14px;color:var(--r-text-3);",
          "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
          ".dsh-room-chatlist-scroll{flex:1;min-height:0;overflow:auto;padding:2px 8px 6px;overscroll-behavior:contain}",
          ".dsh-room-chatlist-scroll::-webkit-scrollbar,.dsh-room-chatlog::-webkit-scrollbar{width:9px}",
          ".dsh-room-chatlist-scroll::-webkit-scrollbar-thumb,.dsh-room-chatlog::-webkit-scrollbar-thumb{",
          "background:var(--dsw-scrollbar-thumb,rgba(0,0,0,.16));border:3px solid transparent;",
          "background-clip:padding-box;border-radius:999px}",
          ".dsh-room-chatitem{display:flex;align-items:center;gap:9px;width:100%;padding:7px 8px;margin-bottom:2px;",
          "border:0;border-radius:10px;background:transparent;color:var(--r-text);text-align:left;cursor:pointer;",
          "font:inherit;transition:background .12s}",
          ".dsh-room-chatitem:hover{background:var(--r-hover)}",
          ".dsh-room-chatitem[data-active=true]{background:var(--r-fill-2)}",
          ".dsh-room-chatitem:focus-visible{outline:2px solid var(--r-accent);outline-offset:-1px}",
          ".dsh-room-chatavatar{flex:none;width:30px;height:30px;border-radius:9px;display:inline-flex;",
          "align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:600;",
          "background:linear-gradient(150deg,hsl(var(--item-hue,214) 72% 62%),hsl(var(--item-hue,214) 68% 48%))}",
          ".dsh-room-chatitem-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}",
          ".dsh-room-chatitem-top{display:flex;align-items:baseline;gap:6px}",
          ".dsh-room-chatitem-name{flex:1;min-width:0;font-size:12.5px;line-height:17px;font-weight:500;",
          "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
          ".dsh-room-chatitem-time{flex:none;font-size:10px;line-height:14px;color:var(--r-text-3)}",
          ".dsh-room-chatitem-bottom{display:flex;align-items:center;gap:6px;min-width:0}",
          ".dsh-room-chatitem-preview{flex:1;min-width:0;font-size:11px;line-height:15px;color:var(--r-text-3);",
          "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
          ".dsh-room-chatitem-badge{flex:none;min-width:16px;height:16px;padding:0 4px;border-radius:8px;",
          "display:inline-flex;align-items:center;justify-content:center;background:var(--r-danger);color:#fff;",
          "font:600 10px/1 var(--r-font)}",
          ".dsh-room-chatlist-foot{flex:none;padding:8px 8px 10px;border-top:.5px solid var(--r-border)}",
          ".dsh-room-chatlist-foot .dsh-room-btn{height:30px;width:100%;justify-content:center}",
          /* 右列：消息流 */
          ".dsh-room-chatmain{display:flex;flex-direction:column;min-width:0;min-height:0;position:relative}",
          ".dsh-room-chathead{display:flex;align-items:center;gap:8px;padding:10px 12px 10px 14px;",
          "border-bottom:.5px solid var(--r-border);flex:none;min-width:0}",
          ".dsh-room-chathead-main{flex:1;min-width:0}",
          ".dsh-room-chathead-title{font-size:13px;line-height:18px;font-weight:600;",
          "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
          ".dsh-room-chathead-sub{margin-top:1px;font-size:10.5px;line-height:14px;color:var(--r-text-3);",
          "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
          ".dsh-room-chatback{display:none;flex:none;width:30px;height:30px;align-items:center;justify-content:center;",
          "border:0;border-radius:8px;background:transparent;color:var(--r-text-2);cursor:pointer}",
          ".dsh-room-chatback:hover{background:var(--r-hover);color:var(--r-text)}",
          ".dsh-room-agentbtn{flex:none;display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 8px;",
          "border:.5px solid var(--r-border);border-radius:8px;background:transparent;color:var(--r-text-2);",
          "font:11.5px/1 var(--r-font);cursor:pointer;transition:background .12s,color .12s}",
          ".dsh-room-agentbtn:hover{background:var(--r-hover);color:var(--r-text)}",
          ".dsh-room-agentbtn[data-on=true]{background:var(--r-fill-2);color:var(--r-text)}",
          ".dsh-room-chatlog{flex:1;min-height:0;overflow:auto;padding:14px;display:flex;flex-direction:column;",
          "gap:12px;overscroll-behavior:contain}",
          ".dsh-room-chatempty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;",
          "gap:6px;padding:24px;text-align:center;color:var(--r-text-3)}",
          ".dsh-room-chatempty-title{font-size:13px;color:var(--r-text-2);font-weight:500}",
          ".dsh-room-chatempty-sub{font-size:11.5px;line-height:17px;max-width:240px}",
          ".dsh-room-msgrow{display:flex;align-items:flex-end;gap:8px;max-width:80%}",
          ".dsh-room-msgrow[data-self=true]{align-self:flex-end;flex-direction:row-reverse}",
          ".dsh-room-msgavatar{flex:none;width:28px;height:28px;border-radius:9px;display:inline-flex;",
          "align-items:center;justify-content:center;color:#fff;font-size:10.5px;font-weight:600;letter-spacing:.02em;",
          "line-height:1;padding:0 2px;overflow:hidden;white-space:nowrap;",
          "background:linear-gradient(150deg,hsl(var(--item-hue,214) 72% 62%),hsl(var(--item-hue,214) 68% 46%));",
          "box-shadow:0 0 0 1px color-mix(in srgb,hsl(var(--item-hue,214) 70% 60%) 45%,transparent)}",
          ".dsh-room-msgmain{min-width:0;display:flex;flex-direction:column;gap:3px}",
          ".dsh-room-msgrow[data-self=true] .dsh-room-msgmain{align-items:flex-end}",
          ".dsh-room-msgmeta{display:flex;align-items:baseline;gap:6px;font-size:10.5px;line-height:14px;color:var(--r-text-3)}",
          /* 昵称用身份色，扫一眼就知道是不是同一个人说的 */
          ".dsh-room-msgname{font-size:12px;font-weight:600;letter-spacing:.01em;",
          "color:hsl(var(--item-hue,214) 62% 42%);max-width:14em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
          "@media (prefers-color-scheme:dark){.dsh-room-msgname{color:hsl(var(--item-hue,214) 68% 70%)}}",
          /* 身份标签：房主 / 访客 / agent —— 让「谁说的」一眼分得清 */
          ".dsh-room-msgrole{flex:none;font-size:9.5px;line-height:12px;padding:1px 4px;border-radius:4px;",
          "background:var(--r-fill-2);color:var(--r-text-3);border:.5px solid var(--r-border)}",
          ".dsh-room-msgrole[data-kind=host]{color:var(--r-warn);background:color-mix(in srgb,var(--r-warn) 12%,transparent);",
          "border-color:color-mix(in srgb,var(--r-warn) 26%,transparent)}",
          ".dsh-room-msgrole[data-kind=agent]{color:var(--r-accent);background:color-mix(in srgb,var(--r-accent) 11%,transparent);",
          "border-color:color-mix(in srgb,var(--r-accent) 26%,transparent)}",
          /* 系统提示：居中一行小字，不带头像和气泡 */
          ".dsh-room-sysmsg{align-self:center;max-width:88%;text-align:center;font:11px/16px var(--r-font);",
          "color:var(--r-text-3);background:var(--r-fill);border-radius:8px;padding:3px 9px;margin:2px 0}",
          /* 被策略拦下时的提示：房客撞墙时得知道「为什么」，不能只有一句默认报错 */
          ".dsh-room-deny{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2147483003;",
          "max-width:min(560px,calc(100vw - 40px));display:flex;align-items:flex-start;gap:8px;",
          "padding:9px 12px;border-radius:10px;font:12px/18px var(--r-font);color:var(--r-text);",
          "background:var(--r-base);border:.5px solid color-mix(in srgb,var(--r-danger) 40%,var(--r-border));",
          "box-shadow:0 8px 24px rgba(0,0,0,.16);opacity:0;pointer-events:none;transition:opacity .16s,transform .16s}",
          ".dsh-room-deny[data-show=true]{opacity:1;pointer-events:auto;transform:translateX(-50%) translateY(-2px)}",
          ".dsh-room-deny .dsh-room-denytitle{font-weight:600;color:var(--r-danger);margin-bottom:2px}",
          /* 会话里的「谁发的」：头像 + 昵称，紧贴在这条指令前面 */
          ".dsh-room-author{display:inline-flex;align-items:center;gap:5px;margin-right:6px;vertical-align:-3px;",
          "padding:1px 6px 1px 2px;border-radius:999px;background:var(--r-fill);border:.5px solid var(--r-border)}",
          ".dsh-room-authoravatar{flex:none;width:18px;height:18px;border-radius:6px;display:inline-flex;",
          "align-items:center;justify-content:center;color:#fff;font-size:9px;font-weight:600;line-height:1;",
          "background:linear-gradient(150deg,hsl(var(--item-hue,214) 72% 62%),hsl(var(--item-hue,214) 68% 46%))}",
          ".dsh-room-authorname{font-size:11.5px;font-weight:600;color:hsl(var(--item-hue,214) 62% 42%)}",
          "@media (prefers-color-scheme:dark){.dsh-room-authorname{color:hsl(var(--item-hue,214) 68% 72%)}}",
          ".dsh-room-msgbubble{padding:7px 10px;border-radius:11px;border-top-left-radius:4px;",
          "background:var(--r-fill);border:.5px solid var(--r-border);color:var(--r-text);",
          "font:12.5px/18px var(--r-font);white-space:pre-wrap;word-break:break-word}",
          ".dsh-room-msgrow[data-self=true] .dsh-room-msgbubble{border-top-left-radius:11px;border-top-right-radius:4px;",
          "background:color-mix(in srgb,var(--r-accent) 12%,transparent);border-color:color-mix(in srgb,var(--r-accent) 26%,transparent)}",
          ".dsh-room-msgrow[data-kind=agent] .dsh-room-msgbubble{border-left:2px solid color-mix(in srgb,var(--r-accent) 55%,transparent)}",
          ".dsh-room-chatinline{flex:none;margin:0 14px 6px;padding:6px 9px;border-radius:8px;font-size:11.5px;line-height:16px;",
          "color:var(--r-danger);background:color-mix(in srgb,var(--r-danger) 9%,transparent);",
          "border:.5px solid color-mix(in srgb,var(--r-danger) 24%,transparent)}",
          ".dsh-room-composer{flex:none;display:flex;align-items:flex-end;gap:8px;padding:10px 12px 12px 14px;",
          "border-top:.5px solid var(--r-border)}",
          ".dsh-room-composer textarea{flex:1;min-width:0;min-height:34px;max-height:96px;padding:7px 10px;",
          "border:.5px solid var(--r-border-strong);border-radius:10px;background:var(--r-base);color:var(--r-text);",
          "font:13px/18px var(--r-font);resize:none;outline:none;transition:border-color .12s,box-shadow .12s}",
          ".dsh-room-composer textarea:focus{border-color:var(--r-accent);",
          "box-shadow:0 0 0 2px color-mix(in srgb,var(--r-accent) 18%,transparent)}",
          ".dsh-room-composer textarea::placeholder{color:var(--r-text-3)}",
          ".dsh-room-send{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;",
          "height:34px;padding:0 13px;border:0;border-radius:10px;background:var(--r-accent);color:#fff;",
          "font:500 12.5px/1 var(--r-font);cursor:pointer;transition:opacity .12s,transform .12s}",
          ".dsh-room-send:hover{opacity:.92}.dsh-room-send:active{transform:scale(.98)}",
          ".dsh-room-send:disabled{opacity:.4;cursor:default}",
          ".dsh-room-send:focus-visible{outline:2px solid var(--r-accent);outline-offset:2px}",
          /* agent 管理浮层 */
          ".dsh-room-agentpop{position:absolute;right:12px;top:52px;z-index:3;width:286px;max-height:280px;",
          "display:flex;flex-direction:column;border-radius:12px;border:.5px solid var(--r-border);",
          "background:var(--r-surface);box-shadow:var(--dsw-elevation-soft,0 10px 30px rgba(0,0,0,.16))}",
          ".dsh-room-agentpop-head{display:flex;align-items:center;gap:6px;padding:10px 12px 6px;flex:none;",
          "font-size:11.5px;color:var(--r-text-2)}",
          ".dsh-room-agentpop-scroll{flex:1;min-height:0;overflow:auto;padding:2px 6px 8px}",
          ".dsh-room-agentrow{display:flex;align-items:center;gap:8px;padding:6px 6px;border-radius:8px;",
          "font:12px/17px var(--r-font);color:var(--r-text-2);cursor:pointer}",
          ".dsh-room-agentrow:hover{background:var(--r-hover);color:var(--r-text)}",
          ".dsh-room-agentrow input{margin:0;accent-color:var(--r-accent)}",
          ".dsh-room-agentrow span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
          /* 手机：面板改成贴着屏幕底部的卡片。高度必须跟着「可视视口」走，
             否则 iOS 地址栏收起时 100vh 仍是大的那个值，会把面板顶到栏下面。 */
          "@media (max-width:560px){.dsh-room-panel{left:8px;right:8px;bottom:8px;width:auto;",
          "max-height:calc(100vh - 16px);max-height:calc(100dvh - 16px)}}",
          /* 手机：聊天面板铺满屏幕，改成「群列表 → 消息」两级切换（类似微信手机端）。 */
          "@media (max-width:560px){.dsh-room-chatpanel{left:0;right:0;top:0;transform:none;width:auto;",
          "height:100vh;height:100dvh;max-height:none;border-radius:0;grid-template-columns:1fr}",
          ".dsh-room-chatpanel[data-view=list] .dsh-room-chatmain{display:none}",
          ".dsh-room-chatpanel[data-view=thread] .dsh-room-chatlist{display:none}",
          ".dsh-room-chatpanel .dsh-room-chatback{display:inline-flex}",
          ".dsh-room-chatlog{padding:12px}.dsh-room-chatitem{padding:9px 8px}",
          ".dsh-room-agentpop{left:12px;right:12px;width:auto}}",
          /* iOS 上输入框字号 <16px 会在聚焦时强制放大整页，手机屏统一抬到 16px。 */
          "@media (max-width:560px){.dsh-room-input,.dsh-room-select,.dsh-room-join-input{font-size:16px}",
          ".dsh-room-tab{height:32px}.dsh-room-kick{display:inline-flex}}",
          "@media (hover:none){.dsh-room-kick{display:inline-flex}",
          ".dsh-room-launch{height:32px;padding:0 11px}.dsh-room-iconbtn{width:32px;height:32px}}",
          ".dsh-room-panel button{touch-action:manipulation;-webkit-tap-highlight-color:transparent}",
          /* 非 HTTPS 下浏览器不给自动复制时的兜底面板 */
          ".dsh-room-copyfallback{position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483001;",
          "display:flex;flex-direction:column;gap:7px;padding:12px;border-radius:12px;",
          "background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#0f1115);",
          "box-shadow:0 16px 40px rgba(0,0,0,.28);color-scheme:light dark;",
          "font:13px/20px var(--dsw-font-family,system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif)}",
          ".dsh-room-copyfallback-label{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#5b6270)}",
          ".dsh-room-copyfallback-text{width:100%;min-height:56px;padding:8px;border-radius:8px;resize:none;",
          "border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.18));background:transparent;color:inherit;",
          "font:12.5px/1.5 var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);",
          "user-select:text;-webkit-user-select:text}",
          ".dsh-room-copyfallback-close{align-self:flex-end;height:28px;padding:0 12px;border-radius:7px;",
          "border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.18));background:transparent;color:inherit;",
          "font:12px/1 var(--dsw-font-family,system-ui,sans-serif);cursor:pointer}",
          "@media (prefers-reduced-motion:reduce){.dsh-room-panel,.dsh-room-chatpanel,.dsh-room-pulse:after,.dsh-room-skel,.dsh-room-toast,.dsh-room-tab-indicator{animation:none!important;transition:none!important}}",
        ].join("");
        document.head.appendChild(style);
      } catch (ignore) { /* 样式失败不影响功能 */ }
    }

    /* ───────────────────────── 通用工具 ───────────────────────── */

    function readError(error) {
      if (!error) return "未知错误";
      if (error.name === "AbortError") return "连接超时：检查组网、房主是否开房、端口是否正确";
      var message = String(error.message || error);
      if (error.status === 403 && message === "请求失败") return "只有房主本机能管理房间";
      if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
        return "连不上：确认双方在同一个蒲公英网络、房主已开房、端口未被防火墙拦截";
      }
      return message;
    }

    function readJsonError(payload) {
      var code = payload && payload.error;
      if (code === "bad-code") return "房间口令不对";
      if (code === "no-room") return "房主还没开房";
      if (code === "too-many-attempts") return "尝试次数太多，请一分钟后再试";
      if (code === "unauthorized") return "登录已失效，请重新加入";
      // 服务端带人话说明时优先用它（例如「当前是只读权限，不能发送消息」）
      if (payload && payload.message) return String(payload.message);
      return code ? String(code) : "请求失败";
    }

    function fetchJson(url, options, timeoutMs) {
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 8000);
      var init = Object.assign({ cache: "no-store", mode: "cors" }, options || {}, { signal: controller.signal });
      return fetch(url, init).then(function (response) {
        return response.text().then(function (text) {
          clearTimeout(timer);
          var payload = null;
          try { payload = text ? JSON.parse(text) : null; } catch (ignore) { payload = null; }
          if (!response.ok) {
            var error = new Error(readJsonError(payload) || ("HTTP " + response.status));
            error.payload = payload;
            error.status = response.status;
            throw error;
          }
          return payload;
        });
      }).catch(function (error) {
        clearTimeout(timer);
        throw error;
      });
    }

    function normalizeAddr(input) {
      var text = String(input || "").trim().replace(/\/+$/, "");
      if (!text) return "";
      if (!/^https?:\/\//i.test(text)) text = "http://" + text;
      try {
        var url = new URL(text);
        if (!url.hostname) return "";
        if (!url.port) url.port = DEFAULT_PORT;
        return url.protocol + "//" + url.hostname + ":" + url.port;
      } catch (ignore) {
        return "";
      }
    }

    function safeStorageGet(key) {
      try { return window.localStorage.getItem(key); } catch (ignore) { return null; }
    }
    function safeStorageSet(key, value) {
      try { window.localStorage.setItem(key, value); } catch (ignore) { /* 忽略 */ }
    }
    function safeStorageRemove(key) {
      try { window.localStorage.removeItem(key); } catch (ignore) { /* 忽略 */ }
    }

    function readGuest() {
      var raw = safeStorageGet(STORAGE_GUEST);
      if (!raw) return null;
      try {
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.addr !== "string" || typeof parsed.token !== "string") return null;
        return { addr: parsed.addr, token: parsed.token, name: String(parsed.name || "访客") };
      } catch (ignore) {
        return null;
      }
    }
    function saveGuest(guest) {
      safeStorageSet(STORAGE_GUEST, JSON.stringify(guest));
    }
    function clearGuest() {
      safeStorageRemove(STORAGE_GUEST);
    }

    function defaultName() {
      var saved = safeStorageGet(STORAGE_NAME);
      if (saved) return saved;
      return "访客" + String(Math.floor(1000 + Math.random() * 9000));
    }

    /**
     * 复制文字。返回 Promise<boolean>。
     *
     * 房客走的是 http://172.16.x.x，不在安全上下文里，navigator.clipboard 直接不存在；
     * 桌面浏览器又常常拒绝「没有用户手势」的 writeText。所以这里三级兜底：
     *   1. navigator.clipboard.writeText（仅安全上下文）
     *   2. textarea + execCommand('copy')（iOS 需要 focus + setSelectionRange）
     *   3. 都失败 → 弹一个可长按选择的面板，让用户自己复制（见 showManualCopy）
     * 不再像旧版那样「当作成功」——失败要如实告诉用户。
     */
    function copyViaSelection(text) {
      var area = null;
      try {
        area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;";
        document.body.appendChild(area);
        // iOS 只认 setSelectionRange；select() 在 textarea 上不可靠
        area.focus();
        if (typeof area.setSelectionRange === "function") area.setSelectionRange(0, area.value.length);
        else area.select();
        return Boolean(document.execCommand("copy"));
      } catch (ignore) {
        return false;
      } finally {
        try { if (area && area.parentNode) area.parentNode.removeChild(area); } catch (ignore) { /* 忽略 */ }
      }
    }

    function copyText(text) {
      var value = String(text == null ? "" : text);
      return new Promise(function (resolve) {
        function fallback() { resolve(copyViaSelection(value)); }
        try {
          if (window.isSecureContext && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            navigator.clipboard.writeText(value).then(function () { resolve(true); }, fallback);
            return;
          }
        } catch (ignore) { /* 落到兜底 */ }
        fallback();
      });
    }

    /** 复制失败时给一个人能操作的出口：把文字摊开、选中，长按即可复制。 */
    function showManualCopy(text) {
      var value = String(text == null ? "" : text);
      try {
        var old = document.getElementById("dsh-room-copyfallback");
        if (old && old.parentNode) old.parentNode.removeChild(old);
        var wrap = document.createElement("div");
        wrap.id = "dsh-room-copyfallback";
        wrap.className = "dsh-room-copyfallback";
        var label = document.createElement("div");
        label.className = "dsh-room-copyfallback-label";
        label.textContent = "浏览器不允许自动复制，请长按下面的文字 → 全选 → 复制";
        var area = document.createElement("textarea");
        area.className = "dsh-room-copyfallback-text";
        area.value = value;
        area.readOnly = true;
        area.spellcheck = false;
        var close = document.createElement("button");
        close.type = "button";
        close.className = "dsh-room-copyfallback-close";
        close.textContent = "知道了";
        function dismiss() {
          try { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); } catch (ignore) { /* 忽略 */ }
        }
        close.addEventListener("click", dismiss);
        wrap.appendChild(label);
        wrap.appendChild(area);
        wrap.appendChild(close);
        document.body.appendChild(wrap);
        area.focus();
        if (typeof area.setSelectionRange === "function") area.setSelectionRange(0, area.value.length);
        setTimeout(dismiss, 15000);
        return true;
      } catch (ignore) {
        return false;
      }
    }

    /** 当前页面是不是「房主浏览器经房间代理打开的页面」。判断依据不是主机名，而是
     *  /room/api/host/state 只有 loopback 直连才给看（代理会拒绝外部来源）。 */
    function currentOrigin() {
      try {
        var origin = String(window.location.origin || "");
        if (!/^https?:\/\//i.test(origin)) return "";
        return origin.replace(/\/+$/, "");
      } catch (ignore) {
        return "";
      }
    }

    function copyOrManual(text) {
      return copyText(text).then(function (ok) {
        if (!ok) showManualCopy(text);
        return ok;
      });
    }

    /* ── 房客撞墙时的明确提示 ──
     * 「只读不能发指令」「目录没开放」「只有房主能做」这类拦截，如果只靠 DSH 自己的
     * 默认报错，房客根本不知道是被权限挡了还是房间坏了。这里给每种拒绝配一句中文，
     * 用一次 fetch 钩子（克隆响应读 body，不动原响应）把说明浮到屏幕下方。
     */
    var DENY_TITLES = {
      "room/readonly": "没有发送权限（只读）",
      "room/blocked": "这个目录房主没开放",
      "room/permission-locked": "房客不能自己改权限",
      "room/host-only": "只有房主能做这个操作",
      "room/approval-owner-only": "审批只能由房主回答",
      "room/payload-too-large": "这次的内容太大了",
    };

    // 旧版宿主只回 { error: 'workspace-readonly' } 这种枚举，没有 code/message；
    // 这里补一层映射，保证不重启宿主也能看见人话提示。
    var DENY_LEGACY = {
      "workspace-readonly": ["room/readonly", "当前是只读权限（房主设置），不能向 Agent 发送指令。需要动手改东西，请让房主把你的权限改成「仅工作区可写」。"],
      "workspace-blocked": ["room/blocked", "这个目录房主没有开放给房客，操作已经被拦下。"],
      "permission-locked": ["room/permission-locked", "房客不能自己改权限，权限统一由房主在房间里设置。"],
      "host-only": ["room/host-only", "这个操作只能在房主自己的电脑上执行。"],
      "approval-owner-only": ["room/approval-owner-only", "审批只能由房主回答，房客看不到、也答不了。"],
      "payload-too-large": ["room/payload-too-large", "这次请求的内容太大，请减少附件或分批发送。"],
    };

    function denyNoticeFor(payload) {
      if (!payload || typeof payload !== "object") return null;
      var code = payload.code ? String(payload.code) : "";
      var message = payload.message ? String(payload.message) : "";
      if (!code) {
        var legacy = DENY_LEGACY[String(payload.error || "")];
        if (legacy) {
          code = legacy[0];
          if (!message) message = legacy[1];
        }
      }
      if (!code || code.indexOf("room/") !== 0) return null;
      return { code: code, title: DENY_TITLES[code] || "操作被拦下", text: message || "这个操作被房间策略拦下了。" };
    }

    var denyEl = null;
    var denyTimer = 0;

    function showDenyNotice(title, text) {
      try {
        if (typeof document === "undefined" || !document.body) return;
        if (!denyEl || !denyEl.parentNode) {
          denyEl = document.createElement("div");
          denyEl.className = "dsh-room-deny";
          denyEl.setAttribute("role", "alert");
          var titleEl = document.createElement("div");
          titleEl.className = "dsh-room-denytitle";
          var textEl = document.createElement("div");
          textEl.className = "dsh-room-denytext";
          var box = document.createElement("div");
          box.appendChild(titleEl);
          box.appendChild(textEl);
          denyEl.appendChild(box);
          document.body.appendChild(denyEl);
        }
        denyEl.firstChild.firstChild.textContent = String(title || "操作被拦下");
        denyEl.firstChild.lastChild.textContent = String(text || "这个操作被房间策略拦下了。");
        denyEl.setAttribute("data-show", "true");
        if (denyTimer) clearTimeout(denyTimer);
        denyTimer = setTimeout(function () {
          if (denyEl) denyEl.setAttribute("data-show", "false");
        }, 7000);
      } catch (ignore) { /* 忽略 */ }
    }

    function installDenyNotice() {
      try {
        if (typeof window === "undefined" || typeof window.fetch !== "function") return false;
        if (window.__dshRoomDenyHook) return true;
        var original = window.fetch;
        window.fetch = function (input, init) {
          var promised = original.apply(this, arguments);
          try {
            var url = typeof input === "string" ? input : (input && input.url) || "";
            if (!/\/api\//.test(url)) return promised;
            if (!promised || typeof promised.then !== "function") return promised;
            return promised.then(function (response) {
              try {
                if (response && response.status === 403 && typeof response.clone === "function") {
                  response.clone().text().then(function (body) {
                    var payload = null;
                    try { payload = JSON.parse(body); } catch (ignore) { payload = null; }
                    var notice = denyNoticeFor(payload);
                    if (notice) showDenyNotice(notice.title, notice.text);
                  }).catch(function () { /* 忽略 */ });
                }
              } catch (ignore) { /* 忽略 */ }
              return response;
            });
          } catch (ignore) {
            return promised;
          }
        };
        window.__dshRoomDenyHook = true;
        return true;
      } catch (ignore) {
        return false;
      }
    }

    /* ── 会话里「这条是谁发的」──
     * DSH 的用户消息没有作者字段，所以房间代理会在房客的指令前加 `〔@访客6105〕`。
     * 这里注册一条 user-text 规则把这个标记单独切成一个节点，再用自己的插槽条目
     * 把它画成「头像 + 昵称」，房主一眼就能看出是谁在说话。
     * 全都兜在 try/catch 里：规则 API 变了就退回纯文本标记，界面不会坏。
     */
    var AUTHOR_NODE_ID = "room-author";
    var AUTHOR_MARK_RE = /^〔@([^〕\n]{1,40})〕/;

    var authorRule = {
      id: AUTHOR_NODE_ID,
      // 排在小节引用（order 10）之前，先把这个标记吃掉
      order: 5,
      match: function (text, from) {
        if (from > 0) return undefined;
        var found = AUTHOR_MARK_RE.exec(String(text || ""));
        if (!found) return undefined;
        return { id: AUTHOR_NODE_ID, start: 0, end: found[0].length, data: { label: found[1] } };
      },
    };

    function AuthorChip(props) {
      var node = props && props.node;
      var label = String((node && node.data && node.data.label) || props.label || "访客");
      var hue = hueFor(label);
      return h("span", {
        className: "dsh-room-author",
        style: { "--item-hue": hue },
        title: "这条指令来自：" + label,
      },
        h("span", { className: "dsh-room-authoravatar", "aria-hidden": "true" }, initialsOf(label)),
        h("span", { className: "dsh-room-authorname" }, label));
    }

    function installAuthorChip(ctx) {
      try {
        var service = null;
        try { service = ctx && typeof ctx.get === "function" ? ctx.get("uiConversation") : null; } catch (ignore) { service = null; }
        if (!service || !service.userText || typeof service.userText.register !== "function") return false;
        service.userText.register(authorRule);
        if (!ctx.slots || typeof ctx.slots.register !== "function") return false;
        ctx.slots.register({
          name: "conversation.user.text.node",
          key: AUTHOR_NODE_ID,
          priority: 100,
        }, AuthorChip);
        return true;
      } catch (ignore) {
        return false;
      }
    }

    function hueFor(name) {      var text = String(name || "?");
      var hash = 0;
      for (var i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
      return hash % 360;
    }

    // 头像上的两个字：中文取前两个字；「访客6105」这类默认名取尾部数字，
    // 否则所有访客的头像都是「访客」两个字，根本分不出谁是谁。
    function initialsOf(name, kind) {
      var clean = String(name || "").replace(/\s+/g, "");
      if (!clean) return "?";
      var digits = clean.match(/(\d{2,4})$/);
      if (digits && clean.length - digits[1].length <= 3) return digits[1].slice(-2);
      if (/^[A-Za-z0-9_.\-]+$/.test(clean)) {
        var parts = String(name).trim().split(/\s+/);
        if (parts.length >= 2 && parts[0] && parts[1]) return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
        return clean.slice(0, 2).toUpperCase();
      }
      return clean.slice(0, 2);
    }

    function relativeTime(stamp) {
      var diff = Date.now() - Number(stamp || 0);
      if (!isFinite(diff) || diff < 0) return "";
      if (diff < 60e3) return "刚刚";
      if (diff < 3600e3) return Math.floor(diff / 60e3) + " 分钟前";
      if (diff < 86400e3) return Math.floor(diff / 3600e3) + " 小时前";
      return Math.floor(diff / 86400e3) + " 天前";
    }

    function formatDuration(ms) {
      var minutes = Math.max(0, Math.floor(Number(ms || 0) / 60e3));
      if (minutes < 1) return "刚刚开启";
      if (minutes < 60) return minutes + " 分钟";
      var hours = Math.floor(minutes / 60);
      var rest = minutes % 60;
      return hours + " 小时" + (rest ? " " + rest + " 分钟" : "");
    }

    function openUrl(url) {
      try { window.open(url, "_blank", "noopener,noreferrer"); } catch (ignore) { /* 忽略 */ }
    }

    // 工作区共享权限的显示文案（服务端枚举：blocked / readonly / write / full）
    function modeLabel(mode) {
      if (mode === "readonly") return "只读";
      if (mode === "write") return "仅工作区可写";
      if (mode === "full") return "完全权限";
      return "未开放";
    }

    function modePill(mode) {
      return h("span", { className: "dsh-room-pill mode-" + String(mode || "blocked") }, modeLabel(mode));
    }

    /* ───────────────────────── 子组件 ───────────────────────── */

    function Toast(props) {
      return h("div", { className: "dsh-room-toast", "data-show": props.text ? "true" : "false", role: "status", "aria-live": "polite" },
        props.text ? h(Fragment, null, h(Icon, { name: "check", size: 13, stroke: 2 }), props.text) : null);
    }

    function Skeleton() {
      return h("div", { className: "dsh-room-skeleton", "aria-hidden": "true" },
        h("div", { className: "dsh-room-skel", style: { width: "92%" } }),
        h("div", { className: "dsh-room-skel", style: { width: "74%" } }),
        h("div", { className: "dsh-room-skel", style: { width: "85%" } }));
    }

    /* ───────────────────── 单选下拉（替代原生 select）───────────────────── */

    // 原生 <select> 在 DSH 面板里样式不统一、且各平台展开层差别很大；
    // 这里用「按钮 + fixed 浮层」自己画，键盘（↑↓/Enter/Esc）与鼠标都可用。
    function Select(props) {
      var options = props.options || [];
      var [open, setOpen] = useState(false);
      var [active, setActive] = useState(-1);
      var [menu, setMenu] = useState(null);
      var triggerRef = useRef(null);
      var popRef = useRef(null);

      var selectedIndex = -1;
      for (var i = 0; i < options.length; i++) {
        if (options[i] && options[i].value === props.value) { selectedIndex = i; break; }
      }
      var current = selectedIndex >= 0 ? options[selectedIndex] : null;
      var label = current && current.label ? String(current.label) : (props.value ? String(props.value) : "");

      function closeMenu() {
        setOpen(false);
        setActive(-1);
      }

      // 浮层用 fixed 定位：面板内部有滚动容器，absolute 会被裁掉。
      function place() {
        var element = triggerRef.current;
        if (!element || typeof element.getBoundingClientRect !== "function") return;
        if (typeof window === "undefined") return;
        var rect = element.getBoundingClientRect();
        var width = Math.max(rect.width, props.minWidth || 136);
        var height = Math.min(240, options.length * 31 + 12);
        var below = (window.innerHeight || 0) - rect.bottom;
        var up = below < height + 14 && rect.top > height + 14;
        var top = up ? rect.top - height - 6 : rect.bottom + 6;
        var left = rect.left;
        var maxLeft = (window.innerWidth || 0) - width - 8;
        if (left > maxLeft) left = Math.max(8, maxLeft);
        setMenu({ left: Math.round(left), top: Math.round(top), width: Math.round(width) });
      }

      function openMenu() {
        place();
        setActive(selectedIndex >= 0 ? selectedIndex : 0);
        setOpen(true);
      }

      function commit(index) {
        var option = options[index];
        closeMenu();
        if (option && props.onChange) props.onChange(option.value);
      }

      useEffect(function () {
        if (!open || typeof document === "undefined") return undefined;
        function onDocDown(event) {
          var target = event.target;
          var pop = popRef.current;
          var trigger = triggerRef.current;
          if (pop && typeof pop.contains === "function" && pop.contains(target)) return;
          if (trigger && typeof trigger.contains === "function" && trigger.contains(target)) return;
          closeMenu();
        }
        function onViewport() { closeMenu(); }
        document.addEventListener("mousedown", onDocDown, true);
        if (typeof window !== "undefined" && window.addEventListener) {
          window.addEventListener("resize", onViewport);
          window.addEventListener("scroll", onViewport, true);
        }
        return function () {
          document.removeEventListener("mousedown", onDocDown, true);
          if (typeof window !== "undefined" && window.removeEventListener) {
            window.removeEventListener("resize", onViewport);
            window.removeEventListener("scroll", onViewport, true);
          }
        };
      }, [open]);

      function onKeyDown(event) {
        // 面板整体把按键吞掉了；这里先 stopPropagation，免得触发 DSH 输入的快捷键。
        event.stopPropagation();
        var key = event.key;
        if (key === "Escape") {
          if (open) { event.preventDefault(); closeMenu(); }
          return;
        }
        if (key === "Tab") { if (open) closeMenu(); return; }
        if (key === "Enter" || key === " ") {
          event.preventDefault();
          if (!open) { openMenu(); return; }
          commit(active >= 0 ? active : selectedIndex);
          return;
        }
        if (key === "ArrowDown" || key === "ArrowUp") {
          event.preventDefault();
          if (!open) { openMenu(); return; }
          var step = key === "ArrowDown" ? 1 : -1;
          var next = active + step;
          if (next < 0) next = options.length - 1;
          if (next >= options.length) next = 0;
          setActive(next);
        }
      }

      return h("div", {
        className: "dsh-room-sel" + (props.sm ? " sm" : "") + (props.wide ? " wide" : ""),
        "data-open": open ? "true" : "false",
        style: props.style || null,
        onKeyDown: onKeyDown,
        onMouseDown: function (event) { event.stopPropagation(); },
      },
        h("button", {
          type: "button",
          className: "dsh-room-sel-trigger",
          ref: triggerRef,
          "aria-haspopup": "listbox",
          "aria-expanded": open ? "true" : "false",
          "aria-label": props.ariaLabel || props.title || label || "选择",
          title: props.title || label || "",
          onClick: function () { if (open) closeMenu(); else openMenu(); },
        },
          h("span", { className: "dsh-room-sel-label" + (label ? "" : " ph") }, label || props.placeholder || "请选择"),
          h("span", { className: "dsh-room-sel-chev" }, h(Icon, { name: "chevron", size: 13, stroke: 1.9 }))),
        (open && menu)
          ? h("div", {
              className: "dsh-room-sel-pop",
              ref: popRef,
              role: "listbox",
              style: { left: menu.left + "px", top: menu.top + "px", width: menu.width + "px" },
            },
              options.map(function (option, index) {
                var isSelected = option.value === props.value;
                return h("div", {
                  key: String(option.value) + "#" + index,
                  className: "dsh-room-sel-opt",
                  role: "option",
                  "aria-selected": isSelected ? "true" : "false",
                  "data-selected": isSelected ? "true" : "false",
                  "data-active": index === active ? "true" : "false",
                  onMouseEnter: function () { setActive(index); },
                  onClick: function () { commit(index); },
                },
                  h("span", { className: "dsh-room-sel-tick" }, h(Icon, { name: "check", size: 12, stroke: 2.4 })),
                  h("span", { className: "dsh-room-sel-text" }, String(option.label)));
              }))
          : null);
    }

    /* ───────────────────────── 面板拖动 ───────────────────────── */

    var STORAGE_POS_PANEL = "dsh-room.pos";
    var STORAGE_POS_CHAT = "dsh-room.chatpos";

    function readStoredPos(key) {
      var raw = safeStorageGet(key);
      if (!raw) return null;
      try {
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
        if (!isFinite(parsed.x) || !isFinite(parsed.y)) return null;
        return { x: Math.round(parsed.x), y: Math.round(parsed.y) };
      } catch (ignore) { return null; }
    }

    // 桌面端用鼠标拖标题栏移动面板；手机端是整屏浮层，不参与拖动。
    function useDraggable(rootRef, storageKey) {
      var [pos, setPos] = useState(readStoredPos(storageKey));
      var [dragging, setDragging] = useState(false);
      var dragRef = useRef(null);
      var posRef = useRef(pos);

      function movable() {
        if (typeof window === "undefined") return false;
        return (window.innerWidth || 0) > 560;
      }

      function targetIsInteractive(target) {
        if (!target || typeof target.closest !== "function") return false;
        return Boolean(target.closest("button,input,textarea,select,a,[data-nodrag='true']"));
      }

      function begin(event) {
        if (event.button !== undefined && event.button !== 0) return;
        if (!movable() || targetIsInteractive(event.target)) return;
        var element = rootRef.current;
        if (!element || typeof element.getBoundingClientRect !== "function") return;
        var rect = element.getBoundingClientRect();
        dragRef.current = {
          dx: event.clientX - rect.left,
          dy: event.clientY - rect.top,
          width: rect.width,
          height: rect.height,
          pointerId: event.pointerId,
        };
        setDragging(true);
        if (event.currentTarget && typeof event.currentTarget.setPointerCapture === "function" && event.pointerId !== undefined) {
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch (ignore) { /* 忽略 */ }
        }
        if (event.preventDefault) event.preventDefault();
      }

      function move(event) {
        var drag = dragRef.current;
        if (!drag) return;
        var maxX = Math.max(6, (window.innerWidth || 0) - drag.width - 6);
        var maxY = Math.max(6, (window.innerHeight || 0) - drag.height - 6);
        var x = Math.min(Math.max(6, event.clientX - drag.dx), maxX);
        var y = Math.min(Math.max(6, event.clientY - drag.dy), maxY);
        var next = { x: Math.round(x), y: Math.round(y) };
        posRef.current = next;
        setPos(next);
      }

      function end() {
        if (!dragRef.current) return;
        dragRef.current = null;
        setDragging(false);
        if (posRef.current) safeStorageSet(storageKey, JSON.stringify(posRef.current));
      }

      function reset() {
        dragRef.current = null;
        posRef.current = null;
        setDragging(false);
        setPos(null);
        safeStorageRemove(storageKey);
      }

      return {
        pos: pos,
        dragging: dragging,
        begin: begin,
        move: move,
        end: end,
        reset: reset,
        // 拖动过就改用 left/top（清掉 CSS 里的 right/bottom 或居中变换）
        style: pos ? { left: pos.x + "px", top: pos.y + "px", right: "auto", bottom: "auto", transform: "none" } : null,
        headProps: {
          onPointerDown: begin,
          onPointerMove: move,
          onPointerUp: end,
          onPointerCancel: end,
          onDoubleClick: function () { reset(); },
          "data-nodrag": "false",
        },
      };
    }

    function MemberList(props) {
      var members = props.members || [];
      if (!members.length) {
        return h("div", { className: "dsh-room-empty" },
          h(Icon, { name: "users", size: 18 }),
          h("div", null, "还没有人加入，把邀请地址发出去吧"));
      }
      return h("div", { className: "dsh-room-members" }, members.map(function (member) {
        var isHost = member.kind === "host";
        var label = isHost ? "房主" : relativeTime(member.lastSeen || member.joinedAt);
        return h("div", { className: "dsh-room-member", key: member.id, title: member.id ? "身份 id：" + member.id : "" },
          // 头像色相按身份 id：同名访客也能分开
          h("span", { className: "dsh-room-avatar" + (isHost ? " host" : ""), style: { "--hue": hueFor(member.id || member.name) } },
            String(member.name || "?").slice(0, 1).toUpperCase(),
            isHost ? h(Icon, { name: "crown", size: 10, className: "crown" }) : null),
          h("span", { className: "dsh-room-mname" }, String(member.name || "未命名")),
          h("span", { className: "dsh-room-mmeta" }, label),
          props.canKick && !isHost
            ? h("button", {
                type: "button",
                className: "dsh-room-kick",
                title: "移出房间",
                "aria-label": "移出 " + String(member.name || ""),
                onClick: function (event) { event.stopPropagation(); props.onKick(member); },
              }, h(Icon, { name: "x", size: 12, stroke: 2 }))
            : null);
      }));
    }

    function AddressList(props) {
      var urls = props.urls || [];
      var [copied, setCopied] = useState("");
      if (!urls.length) {
        urls = [{ url: "http://127.0.0.1:" + (props.port || 8787), ip: "127.0.0.1", label: "本机" }];
      }
      function copy(item) {
        copyOrManual(item.url).then(function (ok) {
          if (ok) {
            setCopied(item.url);
            if (props.onCopied) props.onCopied(item.url);
            setTimeout(function () { setCopied(""); }, 1600);
            return;
          }
          if (props.onError) props.onError();
        });
      }
      return h("div", { className: "dsh-room-addrs" }, urls.map(function (item) {
        var isCopied = copied === item.url;
        return h("button", {
          key: item.url,
          type: "button",
          className: "dsh-room-addr",
          "data-copied": isCopied ? "true" : "false",
          title: "点击复制 " + item.url,
          onClick: function () { copy(item); },
        },
          h("span", { className: "dsh-room-addr-ico" }, h(Icon, { name: "globe", size: 14, stroke: 1.6 })),
          h("span", { className: "dsh-room-addr-text" }, item.url),
          h("span", { className: "dsh-room-addr-tag" }, item.label || ""),
          h("span", { className: "dsh-room-addr-copy" },
            h(Icon, { name: isCopied ? "check" : "copy", size: 14, stroke: isCopied ? 2 : 1.8 }))
        );
      }));
    }

    function Node(props) {
      var entry = props.entry;
      var [open, setOpen] = useState(false);
      var [items, setItems] = useState(null);
      var [error, setError] = useState("");
      var [busy, setBusy] = useState(false);
      var isDir = entry.type === "dir";

      function toggle() {
        if (!isDir) return;
        var next = !open;
        setOpen(next);
        if (next && items === null && !busy) {
          setBusy(true);
          Promise.resolve(props.list(entry.path)).then(function (list) {
            setItems(list || []);
            setError("");
          }).catch(function (failure) {
            setError(readError(failure));
          }).then(function () { setBusy(false); }, function () { setBusy(false); });
        }
      }

      return h("div", { className: "dsh-room-node" },
        h("div", {
          className: "dsh-room-row" + (isDir ? " dir" : ""),
          onClick: toggle,
          role: isDir ? "button" : undefined,
          tabIndex: isDir ? 0 : undefined,
          "aria-expanded": isDir ? (open ? "true" : "false") : undefined,
          onKeyDown: isDir ? function (event) {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); }
          } : undefined,
        },
          isDir
            ? h(Icon, { name: "chevron", size: 12, className: "dsh-room-caret", stroke: 2, attrs: { "data-open": open ? "true" : "false" } })
            : h("span", { className: "dsh-room-caret" }),
          h("span", { className: "dsh-room-ico" + (isDir ? " folder" : "") },
            h(Icon, { name: isDir ? "folder" : "file", size: 14, stroke: 1.7 })),
          h("span", { className: "dsh-room-nm" }, String(entry.name || ""))
        ),
        open ? h("div", { className: "dsh-room-kids" },
          error
            ? h("div", { className: "dsh-room-error" }, error)
            : busy
              ? h("div", { className: "dsh-room-skeleton" },
                  h("div", { className: "dsh-room-skel", style: { width: "70%" } }),
                  h("div", { className: "dsh-room-skel", style: { width: "52%" } }))
              : items && items.length
                ? items.map(function (child) {
                    return h(Node, { key: child.path || child.name, entry: child, list: props.list });
                  })
                : h("div", { className: "dsh-room-muted" }, "空目录")
        ) : null
      );
    }

    function Tree(props) {
      var entries = props.entries || [];
      function list(rel) {
        var url = (props.base || "") + "/room/api/list?path=" + encodeURIComponent(rel || "") +
          "&token=" + encodeURIComponent(props.token || "");
        return fetchJson(url, null, 8000).then(function (payload) {
          if (!payload || !payload.ok) throw new Error(readJsonError(payload));
          return payload.entries || [];
        });
      }
      if (!entries.length) {
        return h("div", { className: "dsh-room-empty" },
          h(Icon, { name: "folder", size: 18 }),
          h("div", null, "工作区是空的"));
      }
      return h("div", { className: "dsh-room-tree" }, entries.map(function (entry) {
        return h(Node, { key: entry.path || entry.name, entry: entry, list: list });
      }));
    }

    /* ───────────────────────── 房主视图 ───────────────────────── */

    function HostView(props) {
      var host = props.host;
      var [name, setName] = useState("");
      var [port, setPort] = useState(String(props.defaultPort || DEFAULT_PORT));
      var [code, setCode] = useState("");
      var [workspace, setWorkspace] = useState("");
      var [busy, setBusy] = useState(false);
      var [error, setError] = useState("");
      var [now, setNow] = useState(Date.now());
      var [folderPath, setFolderPath] = useState("");
      var [folderMode, setFolderMode] = useState("readonly");

      useEffect(function () {
        if (!host) return undefined;
        var timer = setInterval(function () { setNow(Date.now()); }, 30000);
        return function () { clearInterval(timer); };
      }, [host && host.running]);

      useEffect(function () {
        if (!host) return;
        if (!workspace && host.defaultWorkspace) setWorkspace(host.defaultWorkspace);
        if (!name && host.room && host.room.name) setName(host.room.name);
      }, [host]);

      function create() {
        setBusy(true);
        setError("");
        fetchJson("/room/api/host/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: name, port: Number(port) || 8787, code: code, workspace: workspace }),
        }, 12000).then(function (payload) {
          if (!payload || !payload.ok) throw new Error(readJsonError(payload));
          return props.onRefresh();
        }).catch(function (failure) {
          setError(readError(failure));
        }).then(function () { setBusy(false); }, function () { setBusy(false); });
      }

      function stop() {
        setBusy(true);
        setError("");
        fetchJson("/room/api/host/stop", { method: "POST" }, 8000).then(function () {
          return props.onRefresh();
        }).then(function () {
          if (props.notify) props.notify("房间已停止");
        }).catch(function (failure) {
          setError(readError(failure));
        }).then(function () { setBusy(false); }, function () { setBusy(false); });
      }

      function kick(member) {
        fetchJson("/room/api/host/kick", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: member.id }),
        }, 6000).then(function (payload) {
          if (!payload || !payload.ok) throw new Error(readJsonError(payload));
          if (props.notify) props.notify("已移出 " + String(member.name || "成员"));
          return props.onRefresh();
        }).catch(function (failure) {
          setError(readError(failure));
        });
      }

      /* ── 工作区共享权限 ──
       * 默认全部未开放；房主在这里逐个放开并选权限，改动立即落盘（~/.dsh/dsh-room-policy.json）。
       */
      function policyEntries() {
        return (host && host.policy && host.policy.entries) || [];
      }

      function saveEntries(nextEntries) {
        setBusy(true);
        setError("");
        var defaultMode = (host && host.policy && host.policy.defaultMode) || "blocked";
        return fetchJson("/room/api/host/policy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ defaultMode: defaultMode, entries: nextEntries }),
        }, 8000).then(function (payload) {
          if (!payload || !payload.ok) throw new Error(readJsonError(payload));
          return props.onRefresh();
        }).catch(function (failure) {
          setError(readError(failure));
        }).then(function () { setBusy(false); }, function () { setBusy(false); });
      }

      function setWorkspaceMode(path, mode) {
        var entries = policyEntries().filter(function (entry) { return entry.path !== path; });
        if (mode !== "blocked") entries.push({ path: path, mode: mode });
        saveEntries(entries);
      }

      function addFolder() {
        var target = String(folderPath || "").trim();
        if (!target) return;
        var entries = policyEntries().filter(function (entry) { return entry.path !== target; });
        entries.push({ path: target, mode: folderMode });
        setFolderPath("");
        saveEntries(entries);
      }

      function removeEntry(path) {
        saveEntries(policyEntries().filter(function (entry) { return entry.path !== path; }));
      }

      /* ── 选本机文件夹 ──
       * 桌面端走 DSH 自带的选择框（Electron 原生对话框）；没有这个能力时退回手输路径。
       */
      function folderPickerAvailable() {
        return typeof props.pickFolder === "function";
      }

      function pickFolderInto(setter, title) {
        if (!folderPickerAvailable()) return;
        var pending;
        try {
          pending = props.pickFolder(title);
        } catch (failure) {
          setError(readError(failure));
          return;
        }
        if (!pending || typeof pending.then !== "function") return;
        pending.then(function (picked) {
          var next = String(picked || "").trim();
          if (!next) return; // 用户取消
          setter(next);
          setError("");
        }, function (failure) {
          setError(readError(failure));
        });
      }

      function invite(room) {
        var lines = ["【DSH 联机】" + String(room.name || "房间")];
        var first = (host.urls && host.urls[0] && host.urls[0].url) || ("http://127.0.0.1:" + room.port);
        lines.push("地址：" + first);
        if (room.code) lines.push("口令：" + room.code);
        lines.push("手机或电脑浏览器直接打开这个地址，就能进房主的工作台。");
        lines.push("（装了插件的房客：打开 DSH →「联机」→ 访客，输入地址加入。）");
        var text = lines.join("\n");
        copyOrManual(text).then(function (ok) {
          if (props.notify) props.notify(ok ? "邀请文案已复制" : "复制失败，请长按选择文案");
        });
      }

      if (!host) {
        return h("div", { className: "dsh-room-body" },
          props.error
            ? h("div", { className: "dsh-room-error" }, h(Icon, { name: "alert", size: 14 }), props.error)
            : h(Fragment, null, h(Skeleton), h("div", { className: "dsh-room-muted" }, "正在读取本机状态…")));
      }

      if (host.running) {
        var room = host.room || {};
        var duration = formatDuration(now - Number(room.startedAt || now));
        return h(Fragment, null,
          h("div", { className: "dsh-room-body" },
            h("div", { className: "dsh-room-status" },
              h("span", { className: "dsh-room-pulse" }),
              h("div", { className: "dsh-room-status-main" },
                h("div", { className: "dsh-room-status-title" }, String(room.name || "房间")),
                h("div", { className: "dsh-room-status-sub" },
                  "运行中 · " + duration + " · 端口 " + String(room.port || ""))),
              room.needsCode
                ? h("span", { className: "dsh-room-pill warn" }, "口令 " + String(room.code || ""))
                : h("span", { className: "dsh-room-pill ok" }, "无口令")),
            h("div", { className: "dsh-room-section" },
              h("span", { className: "dsh-room-section-title" }, "邀请地址"),
              h("span", { className: "dsh-room-section-spacer" }),
              h("button", { type: "button", className: "dsh-room-ghost", onClick: function () { invite(room); } },
                h(Icon, { name: "link", size: 14, stroke: 1.8 }), "复制邀请")),
            h(AddressList, {
              urls: host.urls,
              port: room.port,
              onCopied: function (url) { if (props.notify) props.notify("已复制 " + url); },
              onError: function () { if (props.notify) props.notify("复制失败，请手动选择"); },
            }),
            h("div", { className: "dsh-room-section" },
              h("span", { className: "dsh-room-section-title" }, "房间成员"),
              h("span", { className: "dsh-room-count" }, String((host.members || []).length))),
            h(MemberList, { members: host.members, canKick: true, onKick: kick }),
            h("div", { className: "dsh-room-section" },
              h("span", { className: "dsh-room-section-title" }, "房主工作区"),
              h("span", { className: "dsh-room-section-spacer" }),
              h("span", { className: "dsh-room-count" }, String((host.workspace && host.workspace.name) || ""))),
            h("div", { className: "dsh-room-path", title: String(room.workspace || "") },
              h(Icon, { name: "folder", size: 14 }), h("span", null, String(room.workspace || ""))),
            (host.workspace && host.workspace.available)
              ? h(Tree, { entries: (host.workspace && host.workspace.entries) || [], token: host.hostToken, base: "" })
              : h("div", { className: "dsh-room-muted" }, "这个工作区当前未对房客开放。"),
            h("div", { className: "dsh-room-section" },
              h("span", { className: "dsh-room-section-title" }, "共享权限"),
              h("span", { className: "dsh-room-section-spacer" }),
              h("span", { className: "dsh-room-count" }, "默认未开放")),
            h("div", { className: "dsh-room-muted", style: { marginBottom: "6px" } },
              "工作区默认对房客不可见；在这里逐个选择权限后，房客才能看到并使用。"),
            (host.workspaces || []).length
              ? h("div", null, (host.workspaces || []).map(function (item) {
                  return h("div", { className: "dsh-room-policy-row", key: item.id || item.path },
                    h("div", { className: "dsh-room-policy-path", title: item.path }, item.title),
                    h(Select, {
                      sm: true,
                      value: item.mode || "blocked",
                      style: { width: "88px" },
                      title: item.title + " 的权限",
                      ariaLabel: item.title + " 的权限",
                      onChange: function (mode) { setWorkspaceMode(item.path, mode); },
                      options: ["blocked", "readonly", "write", "full"].map(function (mode) {
                        return { value: mode, label: modeLabel(mode) };
                      }),
                    }));
                }))
              : h("div", { className: "dsh-room-muted" }, "这台机器还没有登记过工作区。"),
            policyEntries().filter(function (entry) {
              return !(host.workspaces || []).some(function (item) { return item.path === entry.path; });
            }).map(function (entry) {
              return h("div", { className: "dsh-room-policy-row", key: "folder:" + entry.path },
                h("div", { className: "dsh-room-policy-path", title: entry.path }, entry.path),
                modePill(entry.mode),
                h("button", {
                  type: "button",
                  className: "dsh-room-ghost",
                  onClick: function () { removeEntry(entry.path); },
                }, "移除"));
            }),
            h("div", { className: "dsh-room-policy-row" },
              folderPickerAvailable()
                ? h("div", {
                    className: "dsh-room-pickpath",
                    role: "button",
                    tabIndex: 0,
                    title: folderPath || "点这里选择本机的文件夹",
                    onClick: function () { pickFolderInto(setFolderPath, "选择要单独开放的文件夹"); },
                    onKeyDown: function (event) {
                      event.stopPropagation();
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        pickFolderInto(setFolderPath, "选择要单独开放的文件夹");
                      }
                    },
                  },
                    h(Icon, { name: "folder", size: 13 }),
                    h("span", { className: folderPath ? "" : "ph" }, folderPath || "选择要单独开放的文件夹"))
                : h("input", {
                    className: "dsh-room-input",
                    value: folderPath,
                    placeholder: "单独开放某个文件夹（绝对路径）",
                    onChange: function (event) { setFolderPath(event.target.value); },
                    onKeyDown: function (event) { event.stopPropagation(); },
                  }),
              h(Select, {
                sm: true,
                value: folderMode,
                style: { width: "88px" },
                title: "新加文件夹的权限",
                ariaLabel: "新加文件夹的权限",
                onChange: function (mode) { setFolderMode(mode); },
                options: ["readonly", "write", "full"].map(function (mode) {
                  return { value: mode, label: modeLabel(mode) };
                }),
              })),
            h("div", { className: "dsh-room-pickrow" },
              folderPickerAvailable()
                ? h("button", {
                    type: "button",
                    className: "dsh-room-btn ghost sm",
                    onClick: function () { pickFolderInto(setFolderPath, "选择要单独开放的文件夹"); },
                  }, h(Icon, { name: "folder", size: 13 }), "选择文件夹…")
                : null,
              h("span", { className: "dsh-room-section-spacer" }),
              h("button", {
                type: "button",
                className: "dsh-room-btn primary sm",
                onClick: addFolder,
                disabled: busy || !String(folderPath || "").trim(),
              }, "添加")),
            h("div", { className: "dsh-room-note" },
              h(Icon, { name: "shield", size: 14 }),
              "权限只控制房客的可见范围与工作区沙箱；完全权限等于把你的机器交给他，只给信任的人。"),
            error ? h("div", { className: "dsh-room-error" }, h(Icon, { name: "alert", size: 14 }), error) : null),
          h("div", { className: "dsh-room-foot" },
            h("button", { type: "button", className: "dsh-room-btn ghost", onClick: props.onRefresh, disabled: busy },
              h(Icon, { name: "refresh", size: 14, stroke: 1.8 }), "刷新"),
            h("button", { type: "button", className: "dsh-room-btn danger wide", onClick: stop, disabled: busy },
              h(Icon, { name: "stop", size: 14, stroke: 1.8 }), busy ? "正在停止…" : "停止房间")));
      }

      return h("div", { className: "dsh-room-body" },
        h("div", { className: "dsh-room-note info" },
          h(Icon, { name: "info", size: 14 }),
          "建房后，成员可以查看这个工作区的文件列表；真正的读写和操作发生在你打开的「房主工作台」里。"),
        h("div", { className: "dsh-room-field", style: { marginTop: "12px" } },
          h("label", { className: "dsh-room-label" }, "房主工作区"),
          h(Select, {
            wide: true,
            value: workspace,
            title: "房主工作区",
            ariaLabel: "房主工作区",
            placeholder: "选择一个工作区",
            onChange: function (next) { setWorkspace(next); },
            options: (host.workspaces || []).map(function (item) {
              return { value: item.path, label: item.title + " — " + item.path };
            }).concat(
              (host.workspaces || []).some(function (item) { return item.path === workspace; }) || !workspace
                ? []
                : [{ value: workspace, label: workspace }],
            ),
          }),
          folderPickerAvailable()
            ? h("div", { className: "dsh-room-pickrow" },
                h("button", {
                  type: "button",
                  className: "dsh-room-btn ghost sm",
                  onClick: function () { pickFolderInto(setWorkspace, "选择房主工作区文件夹"); },
                }, h(Icon, { name: "folder", size: 13 }), "选择文件夹…"),
                workspace
                  ? h("div", { className: "dsh-room-pickpath", title: workspace },
                      h(Icon, { name: "folder", size: 13 }), h("span", null, workspace))
                  : h("span", { className: "dsh-room-pick-hint" }, "还没选工作区"))
            : h("input", {
                className: "dsh-room-input",
                style: { marginTop: "6px" },
                value: workspace,
                placeholder: "也可以直接填绝对路径，例如 E:\\project",
                onChange: function (event) { setWorkspace(event.target.value); },
                onKeyDown: function (event) { event.stopPropagation(); },
              })),
        h("div", { className: "dsh-room-row2" },
          h("div", { className: "dsh-room-field" },
            h("label", { className: "dsh-room-label" }, "端口"),
            h("input", {
              className: "dsh-room-input",
              value: port,
              inputMode: "numeric",
              onChange: function (event) { setPort(event.target.value.replace(/[^0-9]/g, "")); },
              onKeyDown: function (event) { event.stopPropagation(); },
            })),
          h("div", { className: "dsh-room-field" },
            h("label", { className: "dsh-room-label" }, "房间口令", h("span", { className: "hint" }, "· 可空")),
            h("input", {
              className: "dsh-room-input",
              value: code,
              placeholder: "不填则组网内可直接进",
              onChange: function (event) { setCode(event.target.value); },
              onKeyDown: function (event) { event.stopPropagation(); },
            }))),
        h("div", { className: "dsh-room-field" },
          h("label", { className: "dsh-room-label" }, "房间名"),
          h("input", {
            className: "dsh-room-input",
            value: name,
            placeholder: "例如：老王的开发间",
            onChange: function (event) { setName(event.target.value); },
            onKeyDown: function (event) { event.stopPropagation(); },
          })),
        h("button", { type: "button", className: "dsh-room-btn primary dsh-room-cta", onClick: create, disabled: busy },
          h(Icon, { name: "play", size: 14 }), busy ? "正在建房…" : "创建房间"),
        h("div", { className: "dsh-room-muted", style: { marginTop: "8px" } },
          "默认端口 8787，被占用会自动顺延；首次使用请在 Windows 防火墙放行。"),
        error ? h("div", { className: "dsh-room-error" }, h(Icon, { name: "alert", size: 14 }), error) : null);
    }

    /* ───────────────────────── 访客视图 ───────────────────────── */

    function GuestView(props) {
      var guest = props.guest;
      var state = props.state;
      var suggestedAddr = String(props.suggestedAddr || "");
      var [addr, setAddr] = useState(guest ? guest.addr : suggestedAddr);
      var [name, setName] = useState(guest ? guest.name : defaultName());
      var [code, setCode] = useState("");
      var [busy, setBusy] = useState(false);
      var [error, setError] = useState(String(props.initialError || ""));
      var [latency, setLatency] = useState(0);

      // 掉线自动重入失败时（房间要口令 / 房主关房），父组件会把原因塞进来
      useEffect(function () {
        if (props.initialError) setError(String(props.initialError));
      }, [props.initialError]);

      useEffect(function () {
        if (!guest) return undefined;
        var alive = true;
        function ping() {
          var startedAt = Date.now();
          fetchJson(guest.addr + "/room/api/ping", null, 4500)
            .then(function (payload) {
              if (alive && payload && payload.ok) setLatency(Date.now() - startedAt);
            })
            .catch(function () { /* 保留旧延迟 */ });
        }
        ping();
        var timer = setInterval(ping, 30000);
        return function () { alive = false; clearInterval(timer); };
      }, [guest && guest.addr]);

      function join() {
        var base = normalizeAddr(addr);
        if (!base) {
          setError("地址格式应为 172.16.1.130:8787");
          return;
        }
        setBusy(true);
        setError("");
        var startedAt = Date.now();
        fetchJson(base + "/room/api/ping", null, 4500).then(function (ping) {
          if (!ping || !ping.ok || !ping.room) throw new Error("对方还没有开房");
          setLatency(Date.now() - startedAt);
          if (ping.needsCode && !code) throw new Error("这个房间需要口令");
          return fetchJson(base + "/room/api/join", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: name, code: code }),
          }, 9000);
        }).then(function (payload) {
          if (!payload || !payload.ok) throw new Error(readJsonError(payload));
          safeStorageSet(STORAGE_NAME, name);
          var next = { addr: base, token: payload.token, name: name };
          saveGuest(next);
          props.onJoin(next);
          props.onState({ ok: true, room: payload.room, members: payload.members, workspaces: payload.workspaces, workspace: payload.workspace });
          if (props.notify) props.notify("已加入房间");
        }).catch(function (failure) {
          setError(readError(failure));
        }).then(function () { setBusy(false); }, function () { setBusy(false); });
      }

      function leave() {
        fetchJson(guest.addr + "/room/api/leave?token=" + encodeURIComponent(guest.token), { method: "POST" }, 4000)
          .catch(function () { /* 忽略 */ });
        clearGuest();
        props.onJoin(null);
        props.onState(null);
      }

      function copyAddr() {
        copyOrManual(guest.addr).then(function (ok) {
          if (props.notify) props.notify(ok ? "地址已复制" : "复制失败，请长按选择地址");
        });
      }

      if (guest) {
        var room = (state && state.room) || {};
        var online = Boolean(state && state.ok);
        var sub = (online ? "已连接" : "正在连接…");
        if (latency) sub += " · 延迟 " + latency + "ms";
        sub += " · " + guest.addr;
        var here = currentOrigin();
        var sameOrigin = Boolean(here) && guest.addr === here;
        var currentWorkspace = (state && state.workspace) || null;
        var workspaces = (state && state.workspaces) || [];
        return h(Fragment, null,
          h("div", { className: "dsh-room-body" },
            h("div", { className: "dsh-room-status" },
              h("span", { className: "dsh-room-pulse" + (online ? "" : " off") }),
              h("div", { className: "dsh-room-status-main" },
                h("div", { className: "dsh-room-status-title" }, String(room.name || "已加入房间")),
                h("div", { className: "dsh-room-status-sub", title: sub }, sub)),
              h("span", { className: "dsh-room-pill ok" }, "已连接")),
            sameOrigin
              ? h("div", { className: "dsh-room-note info", style: { marginTop: "12px" } },
                  h(Icon, { name: "info", size: 14 }),
                  "你已经在房间里了——当前这个页面就是房主的工作台，工作区是他的文件夹。")
              : h(Fragment, null,
                  h("button", {
                    type: "button",
                    className: "dsh-room-btn primary dsh-room-cta",
                    style: { marginTop: "12px" },
                    onClick: function () { openUrl(guest.addr + "/"); },
                  },
                    h(Icon, { name: "external", size: 14, stroke: 1.8 }),
                    "进入房主工作台"),
                  h("div", { className: "dsh-room-muted", style: { marginTop: "6px" } },
                    "会打开房主的完整 DSH 界面，工作区就是房主的文件夹；房主也能看到你。")),
            h("div", { className: "dsh-room-section" },
              h("span", { className: "dsh-room-section-title" }, "房间成员"),
              h("span", { className: "dsh-room-count" }, String((state && state.members || []).length))),
            h(MemberList, { members: state && state.members }),
            h("div", { className: "dsh-room-section" },
              h("span", { className: "dsh-room-section-title" }, "开放的工作区"),
              h("span", { className: "dsh-room-section-spacer" }),
              h("span", { className: "dsh-room-count" }, String(workspaces.length)),
              h("button", { type: "button", className: "dsh-room-ghost", onClick: copyAddr },
                h(Icon, { name: "copy", size: 14, stroke: 1.8 }), "复制地址")),
            workspaces.length
              ? h("div", null, workspaces.map(function (item) {
                  return h("div", { className: "dsh-room-member", key: item.id || item.title },
                    h("span", { className: "dsh-room-mname" }, String(item.title || "工作区")),
                    modePill(item.mode));
                }))
              : h("div", { className: "dsh-room-muted" }, "房主还没有开放任何工作区。"),
            (currentWorkspace && currentWorkspace.available)
              ? h(Fragment, null,
                  h("div", { className: "dsh-room-path", title: String(currentWorkspace.root || "") },
                    h(Icon, { name: "folder", size: 12 }),
                    h("span", null, String(currentWorkspace.root || ""))),
                  h(Tree, {
                    base: guest.addr,
                    token: guest.token,
                    entries: currentWorkspace.entries || [],
                  }))
              : null,
            error ? h("div", { className: "dsh-room-error" }, h(Icon, { name: "alert", size: 14 }), error) : null),
          h("div", { className: "dsh-room-foot" },
            h("button", { type: "button", className: "dsh-room-btn ghost wide", onClick: leave },
              h(Icon, { name: "logout", size: 14, stroke: 1.8 }), "离开房间")));
      }

      return h("div", { className: "dsh-room-body" },
        h("div", { className: "dsh-room-field" },
          h("label", { className: "dsh-room-label" }, "房主地址", h("span", { className: "hint" }, "· 不填端口默认 8787")),
          h("input", {
            className: "dsh-room-input dsh-room-join-input",
            value: addr,
            placeholder: "172.16.1.130:8787",
            autoFocus: true,
            spellCheck: false,
            autoComplete: "off",
            autoCapitalize: "none",
            autoCorrect: "off",
            inputMode: "url",
            enterKeyHint: "go",
            onChange: function (event) { setAddr(event.target.value); },
            onKeyDown: function (event) {
              event.stopPropagation();
              if (event.key === "Enter") join();
            },
          })),
        h("div", { className: "dsh-room-row2" },
          h("div", { className: "dsh-room-field" },
            h("label", { className: "dsh-room-label" }, "你的昵称"),
            h("input", {
              className: "dsh-room-input",
              value: name,
              onChange: function (event) { setName(event.target.value); },
              onKeyDown: function (event) { event.stopPropagation(); },
            })),
          h("div", { className: "dsh-room-field" },
            h("label", { className: "dsh-room-label" }, "口令", h("span", { className: "hint" }, "· 可空")),
            h("input", {
              className: "dsh-room-input",
              value: code,
              placeholder: "可空",
              onChange: function (event) { setCode(event.target.value); },
              onKeyDown: function (event) {
                event.stopPropagation();
                if (event.key === "Enter") join();
              },
            }))),
        h("button", { type: "button", className: "dsh-room-btn primary dsh-room-cta", onClick: join, disabled: busy },
          h(Icon, { name: "arrow", size: 14, stroke: 1.9 }),
          busy ? "正在连接…" : "加入房间"),
        h("div", { className: "dsh-room-note info", style: { marginTop: "12px" } },
          h(Icon, { name: "info", size: 14 }),
          suggestedAddr
            ? "你正在从房主的房间地址打开这个页面，地址已经填好，直接点「加入房间」就行。"
            : "先确认双方都在同一个蒲公英网络里，再输入房主面板上显示的地址。"),
        error ? h("div", { className: "dsh-room-error" }, h(Icon, { name: "alert", size: 14 }), error) : null);
    }

    /* ───────────────────────── 面板 ───────────────────────── */

    /* ── 聊天面板：右侧横向长方形。左列群列表（微信式），右列消息流 ── */
    function ChatPanel(props) {
      var isHost = !!props.isHost;
      var base = props.base || "";
      var token = props.token || "";
      var roomOn = !!props.roomOn;

      var seed = props.initial || null;
      var [groups, setGroups] = useState(seed && seed.groups ? seed.groups : []);
      var [messages, setMessages] = useState(seed && seed.messages ? seed.messages : []);
      var [active, setActive] = useState(seed && seed.active ? seed.active : "lobby");
      var [view, setView] = useState("list");
      var [draft, setDraft] = useState("");
      var [error, setError] = useState("");
      var [busy, setBusy] = useState(false);
      var [sending, setSending] = useState(false);
      var [nameDraft, setNameDraft] = useState("");
      var [creating, setCreating] = useState(false);
      var [agents, setAgents] = useState([]);
      var [agentOpen, setAgentOpen] = useState(false);
      var [unread, setUnread] = useState({});
      var sinceRef = useRef(0);
      var logRef = useRef(null);
      var inputRef = useRef(null);
      var activeRef = useRef(active);
      var selfRef = useRef((seed && seed.self) || "");
      var rootRef = useRef(null);
      var drag = useDraggable(rootRef, STORAGE_POS_CHAT);
      activeRef.current = active;

      function withToken(rest) {
        var url = base + rest;
        if (!token) return url;
        return url + (rest.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(token);
      }

      function clock(stamp) {
        try {
          var date = new Date(stamp);
          var now = new Date();
          var hm = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
          if (date.toDateString() === now.toDateString()) return hm;
          return (date.getMonth() + 1) + "/" + date.getDate() + " " + hm;
        } catch (ignore) {
          return "";
        }
      }

      function mergeMessages(incoming) {
        if (!incoming || !incoming.length) return;
        setMessages(function (prev) {
          var known = {};
          prev.forEach(function (item) { known[item.seq] = true; });
          var next = prev.slice();
          incoming.forEach(function (item) { if (!known[item.seq]) next.push(item); });
          next.sort(function (a, b) { return a.seq - b.seq; });
          return next.slice(-400);
        });
        var bump = {};
        incoming.forEach(function (message) {
          if (message.from.kind === "system") return; // 系统提示不亮红点
          if (message.group !== activeRef.current && message.from.id !== selfRef.current) {
            bump[message.group] = (bump[message.group] || 0) + 1;
          }
        });
        if (Object.keys(bump).length) {
          setUnread(function (prev) {
            var next = Object.assign({}, prev);
            Object.keys(bump).forEach(function (key) { next[key] = (next[key] || 0) + bump[key]; });
            return next;
          });
        }
      }

      function pull() {
        return fetchJson(withToken("/room/api/chat/sync?since=" + sinceRef.current), null, 7000)
          .then(function (payload) {
            if (!payload || !payload.ok) return null;
            if (payload.self && payload.self.id) selfRef.current = String(payload.self.id);
            if (typeof payload.seq === "number") sinceRef.current = payload.seq;
            setGroups(payload.groups || []);
            mergeMessages(payload.messages || []);
            setError("");
            return payload;
          })
          .catch(function (failure) {
            setError(readError(failure));
            return null;
          });
      }

      useEffect(function () {
        if (!roomOn) return undefined;
        sinceRef.current = 0;
        setMessages([]);
        pull();
        // 3 秒一轮增量拉取：比 SSE 简单，也不会把宿主 CPU 拖起来
        var timer = setInterval(pull, 3000);
        return function () { clearInterval(timer); };
      }, [roomOn, base, token]);

      useEffect(function () {
        var log = logRef.current;
        if (log && typeof log.scrollHeight === "number") log.scrollTop = log.scrollHeight;
      }, [messages.length, active, view]);

      // 房主：工作区里的会话（= agent 候选）。走插件自己的接口——
      // 直接在页面里打 DSH 的 /api/session/list 会撞令牌栅栏，插件内部代问更稳。
      useEffect(function () {
        if (!isHost || !roomOn) return undefined;
        var alive = true;
        fetchJson("/room/api/host/agents", null, 9000).then(function (payload) {
          if (!alive || !payload || !payload.ok) return;
          setAgents((payload.agents || []).map(function (agent) {
            return { id: String(agent.id || ""), title: String(agent.title || "会话") };
          }).filter(function (agent) { return agent.id; }));
        }).catch(function () {
          if (alive) setAgents([]);
        });
        return function () { alive = false; };
      }, [isHost, roomOn]);

      useEffect(function () {
        function onKeyDown(event) {
          if (event.key !== "Escape") return;
          var narrow = false;
          try { narrow = (window.innerWidth || 0) <= 560; } catch (ignore) { narrow = false; }
          if (narrow && view === "thread") {
            event.stopPropagation();
            setView("list");
            return;
          }
          props.onClose();
        }
        document.addEventListener("keydown", onKeyDown, true);
        return function () { document.removeEventListener("keydown", onKeyDown, true); };
      }, [view]);

      function select(groupId) {
        setActive(groupId);
        setView("thread");
        setAgentOpen(false);
        setError("");
        setUnread(function (prev) {
          if (!prev[groupId]) return prev;
          var next = Object.assign({}, prev);
          delete next[groupId];
          return next;
        });
      }

      function send() {
        var text = draft.trim();
        if (!text || sending || !roomOn) return;
        setSending(true);
        fetchJson(withToken("/room/api/chat/send"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ group: active, text: text }),
        }, 9000).then(function (payload) {
          if (!payload || !payload.ok) throw new Error(readJsonError(payload));
          setDraft("");
          if (payload.message) {
            mergeMessages([payload.message]);
            if (payload.message.seq > sinceRef.current) sinceRef.current = payload.message.seq;
          }
        }).catch(function (failure) {
          setError(readError(failure));
        }).then(function () { setSending(false); }, function () { setSending(false); });
      }

      function createGroup() {
        var name = nameDraft.trim();
        if (!name || busy) return;
        setBusy(true);
        fetchJson("/room/api/host/chat/group", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: name }),
        }, 9000).then(function (payload) {
          if (!payload || !payload.ok) throw new Error(readJsonError(payload));
          setNameDraft("");
          setCreating(false);
          if (payload.groups) setGroups(payload.groups);
          if (payload.group) select(payload.group.id);
        }).catch(function (failure) {
          setError(readError(failure));
        }).then(function () { setBusy(false); }, function () { setBusy(false); });
      }

      function toggleAgent(agent, joined) {
        if (busy) return;
        setBusy(true);
        fetchJson("/room/api/host/chat/member", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ group: active, agentId: agent.id, agentTitle: agent.title, remove: joined }),
        }, 9000).then(function (payload) {
          if (!payload || !payload.ok) throw new Error(readJsonError(payload));
          if (payload.groups) setGroups(payload.groups);
        }).catch(function (failure) {
          setError(readError(failure));
        }).then(function () { setBusy(false); }, function () { setBusy(false); });
      }

      function removeGroup(groupId) {
        if (busy) return;
        try {
          if (typeof window !== "undefined" && typeof window.confirm === "function") {
            if (!window.confirm("删除这个聊天群？群里的消息会一起消失。")) return;
          }
        } catch (ignore) { /* 忽略 */ }
        setBusy(true);
        fetchJson("/room/api/host/chat/group?group=" + encodeURIComponent(groupId), { method: "DELETE" }, 9000)
          .then(function (payload) {
            if (!payload || !payload.ok) throw new Error(readJsonError(payload));
            if (payload.groups) setGroups(payload.groups);
            select("lobby");
          }).catch(function (failure) {
            setError(readError(failure));
          }).then(function () { setBusy(false); }, function () { setBusy(false); });
      }

      var activeGroup = null;
      for (var index = 0; index < groups.length; index++) {
        if (groups[index].id === active) activeGroup = groups[index];
      }
      var visible = messages.filter(function (message) { return message.group === active; });
      var memberIds = {};
      if (activeGroup && activeGroup.agents) {
        activeGroup.agents.forEach(function (agent) { memberIds[agent.id] = true; });
      }

      function lastMessageOf(groupId) {
        for (var cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
          if (messages[cursor].group === groupId) return messages[cursor];
        }
        return null;
      }

      function previewOf(message) {
        if (!message) return "";
        var text = String(message.text || "").replace(/\s+/g, " ");
        var kind = message.from.kind;
        if (kind === "system") return text.slice(0, 48);
        if (kind === "agent") text = message.from.name + "：" + text;
        else if (kind === "host") text = "房主：" + text;
        else text = message.from.name + "：" + text;
        return text.slice(0, 48);
      }

      function renderMessage(message) {
        var myId = selfRef.current || (seed && seed.self) || "";
        var kind = message.from.kind || "user";
        // 系统提示（谁进房 / 谁离房 / agent 被拉进群）不是人说的话：居中的一行小字。
        if (kind === "system") {
          return h("div", { key: String(message.seq), className: "dsh-room-sysmsg" },
            h("span", null, message.text));
        }
        // 自己认自己：靠稳定 id，不靠名字（同名也不会认错）
        var self = myId !== "" && message.from.id === myId;
        var role = kind === "agent" ? "agent" : kind === "host" ? "房主" : "访客";
        var name = String(message.from.name || "?").replace(/\s+/g, " ").trim() || "?";
        // 身份色：同一个 id 永远同一个颜色，不同的人（哪怕同名）一定不同色
        var hue = hueFor(message.from.id || name);
        var initial = initialsOf(name, kind);
        return h("div", {
          key: String(message.seq),
          className: "dsh-room-msgrow",
          "data-self": self ? "true" : "false",
          "data-kind": kind,
          "data-identity": message.from.id || "",
          style: { "--item-hue": hue },
        },
          h("span", {
            className: "dsh-room-msgavatar",
            "aria-hidden": "true",
            title: name + "（" + role + (message.from.id ? " · " + message.from.id : "") + "）",
            style: { "--item-hue": hue },
          }, initial),
          h("div", { className: "dsh-room-msgmain" },
            h("div", { className: "dsh-room-msgmeta" },
              h("span", { className: "dsh-room-msgname", title: message.from.id ? message.from.id : "" }, name),
              h("span", { className: "dsh-room-msgrole", "data-kind": kind }, role),
              h("span", null, clock(message.at))),
            h("div", { className: "dsh-room-msgbubble" }, message.text)));
      }

      function renderListItem(group) {
        var last = lastMessageOf(group.id);
        var count = Number(unread[group.id] || 0);
        return h("button", {
          key: group.id,
          type: "button",
          className: "dsh-room-chatitem",
          "data-active": group.id === active ? "true" : "false",
          title: group.name,
          onClick: function () { select(group.id); },
        },
          h("span", {
            className: "dsh-room-chatavatar",
            "aria-hidden": "true",
            style: { "--item-hue": hueFor(group.name) },
          }, group.name.slice(0, 1)),
          h("span", { className: "dsh-room-chatitem-main" },
            h("span", { className: "dsh-room-chatitem-top" },
              h("span", { className: "dsh-room-chatitem-name" }, group.name),
              last ? h("span", { className: "dsh-room-chatitem-time" }, clock(last.at)) : null),
            h("span", { className: "dsh-room-chatitem-bottom" },
              h("span", { className: "dsh-room-chatitem-preview" },
                last ? previewOf(last) : (group.agents && group.agents.length ? group.agents.length + " 个 agent 在群里" : "还没有消息")),
              count > 0
                ? h("span", { className: "dsh-room-chatitem-badge" }, count > 99 ? "99+" : String(count))
                : null)));
      }

      var headSub = activeGroup
        ? (activeGroup.agents && activeGroup.agents.length
            ? activeGroup.name + " · " + activeGroup.agents.length + " 个 agent"
            : "房间里的人都在这个群")
        : (roomOn ? "房间聊天" : "房间未开启");

      return h("div", {
        className: "dsh-room-chatpanel",
        "data-view": view,
        "data-dragging": drag.dragging ? "true" : "false",
        role: "dialog",
        "aria-label": "房间聊天",
        ref: rootRef,
        style: drag.style,
        onMouseDown: function (event) { event.stopPropagation(); },
      },
        h("div", { className: "dsh-room-chatlist" },
          h("div", Object.assign({ className: "dsh-room-chatlist-head", title: "拖动可移动面板" }, drag.headProps),
            h("div", { style: { flex: 1, minWidth: 0 } },
              h("div", { className: "dsh-room-chatlist-title" }, "房间聊天"),
              h("div", { className: "dsh-room-chatlist-sub" }, props.roomName || (roomOn ? "已连上房间" : "未连接"))),
            h("button", {
              type: "button",
              className: "dsh-room-iconbtn",
              title: "关闭聊天",
              "aria-label": "关闭聊天",
              onClick: props.onClose,
            }, h(Icon, { name: "x", size: 13, stroke: 1.8 }))),
          h("div", { className: "dsh-room-chatlist-scroll" },
            groups.length
              ? groups.map(renderListItem)
              : h("div", { className: "dsh-room-chatlist-sub", style: { padding: "8px 6px" } }, roomOn ? "正在加载群…" : "房间未开启")),
          isHost && roomOn
            ? h("div", { className: "dsh-room-chatlist-foot" },
                creating
                  ? h("div", { style: { display: "flex", gap: 6 } },
                      h("input", {
                        className: "dsh-room-input",
                        autoFocus: true,
                        value: nameDraft,
                        placeholder: "群名",
                        "aria-label": "群名",
                        onChange: function (event) { setNameDraft(event.target.value); },
                        onKeyDown: function (event) {
                          if (event.key === "Enter") { event.preventDefault(); createGroup(); }
                          if (event.key === "Escape") { event.stopPropagation(); setCreating(false); }
                        },
                      }),
                      h("button", {
                        type: "button",
                        className: "dsh-room-btn primary",
                        disabled: busy || !nameDraft.trim(),
                        onClick: createGroup,
                        style: { flex: "none", width: "auto", padding: "0 12px" },
                      }, "建群"))
                  : h("button", {
                      type: "button",
                      className: "dsh-room-btn ghost",
                      onClick: function () { setCreating(true); },
                    }, h(Icon, { name: "plus", size: 12 }), "新建群"))
            : null),
        h("div", { className: "dsh-room-chatmain" },
          h("div", Object.assign({ className: "dsh-room-chathead", title: "拖动可移动面板" }, drag.headProps),
            h("button", {
              type: "button",
              className: "dsh-room-chatback",
              title: "返回群列表",
              "aria-label": "返回群列表",
              onClick: function () { setView("list"); },
            }, h(Icon, { name: "back", size: 15 })),
            h("div", { className: "dsh-room-chathead-main" },
              h("div", { className: "dsh-room-chathead-title" }, activeGroup ? activeGroup.name : "大厅"),
              h("div", { className: "dsh-room-chathead-sub" }, headSub)),
            isHost && roomOn
              ? h("button", {
                  type: "button",
                  className: "dsh-room-agentbtn",
                  "data-on": agentOpen ? "true" : "false",
                  title: "把 agent 拉进这个群",
                  onClick: function () { setAgentOpen(!agentOpen); },
                }, h(Icon, { name: "users", size: 12 }), "agent")
              : null,
            isHost && roomOn && activeGroup && activeGroup.id !== "lobby"
              ? h("button", {
                  type: "button",
                  className: "dsh-room-iconbtn",
                  title: "删除这个群",
                  "aria-label": "删除这个群",
                  onClick: function () { removeGroup(activeGroup.id); },
                }, h(Icon, { name: "trash", size: 13 }))
              : null),
          h("div", { className: "dsh-room-chatlog", ref: logRef },
            visible.length
              ? visible.map(renderMessage)
              : h("div", { className: "dsh-room-chatempty" },
                  h(Icon, { name: "chat", size: 22, stroke: 1.4 }),
                  h("div", { className: "dsh-room-chatempty-title" }, roomOn ? "这里还很安静" : "房间未开启"),
                  h("div", { className: "dsh-room-chatempty-sub" },
                    roomOn
                      ? "发第一条消息吧。房主可以把工作区里的 agent 拉进这个群，agent 也会在这里说话。"
                      : "先在「联机」面板里开房或加入房间，聊天群才会出现。"))),
          error ? h("div", { className: "dsh-room-chatinline" }, error) : null,
          h("div", { className: "dsh-room-composer" },
            h("textarea", {
              ref: inputRef,
              className: "dsh-room-input",
              rows: 1,
              value: draft,
              placeholder: roomOn ? "发消息，Enter 发送，Shift+Enter 换行" : "房间未开启",
              "aria-label": "聊天输入",
              onChange: function (event) { setDraft(event.target.value); },
              onKeyDown: function (event) {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              },
            }),
            h("button", {
              type: "button",
              className: "dsh-room-send",
              disabled: sending || !draft.trim() || !roomOn,
              onClick: send,
              title: "发送",
            }, h(Icon, { name: "send", size: 13 }), "发送")),
          agentOpen && isHost
            ? h("div", { className: "dsh-room-agentpop" },
                h("div", { className: "dsh-room-agentpop-head" },
                  h("span", { style: { flex: 1 } }, "把 agent 拉进「" + (activeGroup ? activeGroup.name : "大厅") + "」")),
                h("div", { className: "dsh-room-agentpop-scroll" },
                  agents.length
                    ? agents.map(function (agent) {
                        var joined = !!memberIds[agent.id];
                        return h("label", { key: agent.id, className: "dsh-room-agentrow" },
                          h("input", {
                            type: "checkbox",
                            checked: joined,
                            disabled: busy,
                            onChange: function () { toggleAgent(agent, joined); },
                          }),
                          h("span", null, agent.title));
                      })
                    : h("div", { className: "dsh-room-chathead-sub", style: { padding: "6px 8px" } }, "没有可用的会话")))
            : null));
    }

    function Panel(props) {
      // 访客状态由 RoomButton 持有：自动加入、心跳保活、刷新按钮上的绿点共用同一份。
      var guest = props.guest || null;
      var guestState = props.guestState || null;
      var [tab, setTab] = useState(guest ? "guest" : "host");
      var [host, setHost] = useState(null);
      var [hostError, setHostError] = useState("");
      var [toast, setToast] = useState("");
      var rootRef = useRef(null);
      var toastTimer = useRef(null);
      var drag = useDraggable(rootRef, STORAGE_POS_PANEL);

      function notify(text) {
        setToast(text);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(function () { setToast(""); }, 1800);
      }

      function refreshHost() {
        return fetchJson("/room/api/host/state", null, 5000).then(function (payload) {
          if (payload && payload.ok) {
            setHost(payload);
            setHostError("");
          }
          return payload;
        }).catch(function (failure) {
          setHostError(readError(failure));
          return null;
        });
      }

      useEffect(function () {
        refreshHost().then(function (payload) {
          if (payload && payload.running) setTab("host");
          else if (guest) setTab("guest");
        });
        return function () {
          if (toastTimer.current) clearTimeout(toastTimer.current);
        };
      }, []);

      useEffect(function () {
        if (!host || !host.running) return undefined;
        var timer = setInterval(function () { refreshHost(); }, 5000);
        return function () { clearInterval(timer); };
      }, [host && host.running]);

      useEffect(function () {
        if (!guest) return undefined;
        var alive = true;
        function tick() {
          fetchJson(guest.addr + "/room/api/state?token=" + encodeURIComponent(guest.token), null, 7000)
            .then(function (payload) {
              if (!alive || !payload || !payload.ok) return;
              if (props.onGuestState) props.onGuestState(payload);
            })
            .catch(function (failure) {
              // 令牌被清理（后台超时）时父组件会重新入房，这里只保留上一次画面
              if (!alive) return;
              if (props.onStale && failure && (failure.status === 401 || (failure.payload && failure.payload.stale))) props.onStale();
            });
        }
        tick();
        var timer = setInterval(tick, 8000);
        return function () { alive = false; clearInterval(timer); };
      }, [guest && guest.addr, guest && guest.token]);

      useEffect(function () {
        if (typeof document === "undefined" || typeof document.addEventListener !== "function") return undefined;
        function onPointerDown(event) {
          var target = event.target;
          if (rootRef.current && typeof rootRef.current.contains === "function" && rootRef.current.contains(target)) return;
          var button = props.buttonRef && props.buttonRef.current;
          if (button && typeof button.contains === "function" && button.contains(target)) return;
          props.onClose();
        }
        function onKeyDown(event) {
          if (event.key === "Escape") props.onClose();
        }
        document.addEventListener("mousedown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return function () {
          document.removeEventListener("mousedown", onPointerDown, true);
          document.removeEventListener("keydown", onKeyDown, true);
        };
      }, []);

      var anchorStyle = {};
      if (props.anchor) {
        anchorStyle["--room-right"] = props.anchor.right + "px";
        anchorStyle["--room-bottom"] = props.anchor.bottom + "px";
        anchorStyle["--room-maxh"] = props.anchor.maxHeight + "px";
      }
      // 拖过之后用 left/top 定位，覆盖掉 CSS 里的 right/bottom 锚定。
      if (drag.pos) {
        anchorStyle = Object.assign({}, anchorStyle, drag.style);
      }

      var close = function () { props.onClose(); };

      return h("div", {
        className: "dsh-room-panel",
        role: "dialog",
        "aria-label": "房间联机",
        "data-dragging": drag.dragging ? "true" : "false",
        style: anchorStyle,
        ref: rootRef,
        onMouseDown: function (event) { event.stopPropagation(); },
        onKeyDown: function (event) { event.stopPropagation(); },
      },
        h("div", Object.assign({ className: "dsh-room-head", title: "拖动可移动面板" }, drag.headProps),
          h("div", { className: "dsh-room-heading" },
            h("div", { className: "dsh-room-title" }, "房间联机"),
            h("div", { className: "dsh-room-sub" }, "蒲公英组网 · 共享同一个 DSH 工作区")),
          h("button", {
            type: "button",
            className: "dsh-room-iconbtn",
            title: "打开房间聊天",
            "aria-label": "打开房间聊天",
            onClick: function () { if (props.onChat) props.onChat(); },
          }, h(Icon, { name: "chat", size: 14, stroke: 1.6 })),
          h("button", { type: "button", className: "dsh-room-iconbtn", onClick: close, title: "关闭", "aria-label": "关闭" },
            h(Icon, { name: "x", size: 14, stroke: 1.8 }))),
        h("div", {
          className: "dsh-room-tabs",
          role: "tablist",
          style: { "--tab-index": tab === "host" ? 0 : 1 },
        },
          h("span", { className: "dsh-room-tab-indicator", "aria-hidden": "true" }),
          h("button", {
            type: "button",
            role: "tab",
            "aria-selected": tab === "host" ? "true" : "false",
            className: "dsh-room-tab",
            "data-active": tab === "host" ? "true" : "false",
            onClick: function () { setTab("host"); },
          }, "房主"),
          h("button", {
            type: "button",
            role: "tab",
            "aria-selected": tab === "guest" ? "true" : "false",
            className: "dsh-room-tab",
            "data-active": tab === "guest" ? "true" : "false",
            onClick: function () { setTab("guest"); },
          }, "访客")),
        tab === "host"
          ? h(HostView, {
              host: host,
              error: hostError,
              notify: notify,
              pickFolder: props.pickFolder,
              onRefresh: refreshHost,
            })
          : h(GuestView, {
              guest: guest,
              state: guestState,
              suggestedAddr: props.suggestedAddr,
              initialError: props.joinError,
              notify: notify,
              onJoin: function (next) { if (props.onGuest) props.onGuest(next); },
              onState: function (next) { if (props.onGuestState) props.onGuestState(next); },
            }),
        h(Toast, { text: toast })
      );
    }

    /* ───────────────────────── 启动按钮 ───────────────────────── */

    function RoomButton(injectedProps) {
      // 插槽 inject() 会把 pickFolder 之类的服务作为 props 传进来；直接渲染时可能没有。
      var props = injectedProps || {};
      var [open, setOpen] = useState(false);
      var [chatOpen, setChatOpen] = useState(false);
      var [anchor, setAnchor] = useState(null);
      var [live, setLive] = useState(false);
      var [guest, setGuest] = useState(readGuest);
      var [guestState, setGuestState] = useState(null);
      var [joinError, setJoinError] = useState("");
      var [suggestedAddr, setSuggestedAddr] = useState("");
      var buttonRef = useRef(null);
      ensureStyle();

      function viewportHeight() {
        try {
          var vv = window.visualViewport;
          if (vv && vv.height) return vv.height;
        } catch (ignore) { /* 老浏览器没有 */ }
        return window.innerHeight || 0;
      }

      /* 房主本机的页面：/room/api/host/state 只有 loopback 直连才给看。
         房客的手机经代理打开时这个接口 403，于是我们把当前 origin 当成房间地址：
         自动以访客身份加入，房主立刻能在成员里看到人。 */
      useEffect(function () {
        if (autoJoinAttempted) return undefined;
        autoJoinAttempted = true;
        var alive = true;
        var origin = currentOrigin();
        function guestPath() {
          if (!alive || !origin) return undefined;
          setSuggestedAddr(origin);
          var saved = readGuest();
          if (saved && saved.addr === origin) return undefined;
          return fetchJson("/room/api/ping", null, 4000).then(function (ping) {
            if (!alive || !ping || !ping.ok || !ping.room) return undefined;
            setLive(true);
            // 需要口令时不要偷偷试错（会撞上加入频控），让房客自己在面板里填
            if (ping.needsCode) return undefined;
            var name = defaultName();
            return fetchJson(origin + "/room/api/join", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: name, code: "" }),
            }, 9000).then(function (joined) {
              if (!alive || !joined || !joined.ok) return undefined;
              safeStorageSet(STORAGE_NAME, name);
              var next = { addr: origin, token: joined.token, name: name };
              saveGuest(next);
              setGuest(next);
              // 手机第一次从房主地址打开时，面板就是「房间页」：摊开让房客看到自己已加入
              setOpen(true);
              return undefined;
            });
          });
        }
        fetchJson("/room/api/host/state", null, 4000).then(function (payload) {
          if (payload && payload.ok) return undefined; // 房主本机
          return guestPath();
        }).catch(function () {
          // 代理拒绝 host-only 接口时会返回非 JSON，这里也按房客处理
          return guestPath();
        });
        return function () { alive = false; };
      }, []);

      /* 在线保活 + 掉线自动重入。
         手机切到后台后浏览器会冻结/节流定时器，超过服务端 MEMBER_TTL 就会被清理，
         表现为「房主那边看不到我了 / 我自己面板成员变 0」。回到前台立刻补一次心跳，
         令牌已失效（401 stale）就静默重新入房，不需要用户手动操作。 */
      useEffect(function () {
        if (!guest || !guest.addr) return undefined;
        var alive = true;
        var rejoining = false;
        var base = guest.addr;
        var token = guest.token;
        var name = guest.name || defaultName();

        function applyState(payload) {
          if (!alive || !payload || !payload.ok) return;
          setLive(true);
          setGuestState({ ok: true, room: payload.room, members: payload.members, workspaces: payload.workspaces, workspace: payload.workspace });
        }

        function rejoin() {
          if (!alive || rejoining) return;
          rejoining = true;
          fetchJson(base + "/room/api/join", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: name, code: "" }),
          }, 9000).then(function (joined) {
            if (!alive) return undefined;
            if (!joined || !joined.ok) throw new Error(readJsonError(joined));
            var next = { addr: base, token: joined.token, name: name };
            saveGuest(next);
            setGuest(next);
            setJoinError("");
            setLive(true);
            setGuestState({ ok: true, room: joined.room, members: joined.members, workspaces: joined.workspaces, workspace: joined.workspace });
            rejoining = false;
            return undefined;
          }).catch(function (failure) {
            if (!alive) return;
            rejoining = false;
            // 房间要口令 / 房主已关房 / 网络断了：退回加入表单，把原因写清楚
            clearGuest();
            setGuest(null);
            setGuestState(null);
            setJoinError(readError(failure));
            setOpen(true);
          });
        }

        function beat() {
          if (!alive) return;
          fetchJson(base + "/room/api/heartbeat?token=" + encodeURIComponent(token), { method: "POST" }, 7000)
            .then(applyState)
            .catch(function (failure) {
              if (!alive) return;
              setLive(false);
              if (failure && (failure.status === 401 || (failure.payload && failure.payload.stale))) rejoin();
            });
        }

        beat();
        var timer = setInterval(beat, 20000);
        function onVisible() {
          if (document.visibilityState === "visible") beat();
        }
        // visibilitychange：移动浏览器切回前台；pageshow：iOS 从 bfcache 恢复
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("pageshow", beat);
        window.addEventListener("online", beat);
        window.addEventListener("focus", beat);
        return function () {
          alive = false;
          clearInterval(timer);
          document.removeEventListener("visibilitychange", onVisible);
          window.removeEventListener("pageshow", beat);
          window.removeEventListener("online", beat);
          window.removeEventListener("focus", beat);
        };
      }, [guest && guest.addr, guest && guest.token]);

      useEffect(function () {
        var alive = true;
        function check() {
          fetchJson("/room/api/ping", null, 4000).then(function (payload) {
            if (alive && payload && payload.ok) setLive(Boolean(payload.room));
          }).catch(function () { /* 宿主没起来时保持静默 */ });
        }
        check();
        var timer = setInterval(check, 15000);
        return function () { alive = false; clearInterval(timer); };
      }, []);

      function place() {
        var element = buttonRef.current;
        if (!element || typeof element.getBoundingClientRect !== "function") return;
        var rect = element.getBoundingClientRect();
        var layoutHeight = window.innerHeight || 0;
        var visibleHeight = Math.min(layoutHeight, viewportHeight() || layoutHeight);
        var right = Math.max(8, (window.innerWidth || 0) - rect.right);
        var bottom = Math.max(8, layoutHeight - rect.top + 8);
        var maxHeight = Math.max(240, visibleHeight - bottom - 12);
        setAnchor({ right: right, bottom: bottom, maxHeight: maxHeight });
      }

      function toggle() {
        if (!open) place();
        setOpen(!open);
      }

      useEffect(function () {
        if (!open) return undefined;
        function onResize() { place(); }
        window.addEventListener("resize", onResize);
        // iOS 地址栏收放不一定触发 window.resize，visualViewport 更可靠
        var vv = null;
        try { vv = window.visualViewport } catch (ignore) { vv = null }
        if (vv && typeof vv.addEventListener === "function") vv.addEventListener("resize", onResize);
        return function () {
          window.removeEventListener("resize", onResize);
          if (vv && typeof vv.removeEventListener === "function") vv.removeEventListener("resize", onResize);
        };
      }, [open]);

      return h(Fragment, null,
        h("button", {
          ref: buttonRef,
          type: "button",
          className: "dsh-room-launch",
          "data-open": open ? "true" : "false",
          "data-live": live ? "true" : "false",
          title: guest ? ("已在房间里：" + guest.name) : "房间联机",
          "aria-haspopup": "dialog",
          "aria-expanded": open ? "true" : "false",
          onClick: toggle,
        },
          h(Icon, { name: "users", size: 14, stroke: 1.7 }),
          "联机",
          live ? h("span", { className: "live-dot" }) : null),
        open ? h(Panel, {
          anchor: anchor,
          buttonRef: buttonRef,
          guest: guest,
          guestState: guestState,
          joinError: joinError,
          suggestedAddr: suggestedAddr,
          pickFolder: props.pickFolder,
          onGuestState: setGuestState,
          onGuest: function (next) {
            setGuest(next);
            if (!next) setGuestState(null);
            else setJoinError("");
          },
          onChat: function () {
            setOpen(false);
            setChatOpen(true);
          },
          onClose: function () { setOpen(false); },
        }) : null,
        chatOpen ? h(ChatPanel, {
          base: guest ? guest.addr : "",
          token: guest ? guest.token : "",
          isHost: !guest,
          roomOn: guest ? Boolean(guestState && guestState.room) : live,
          roomName: (guestState && guestState.room && guestState.room.name) || "",
          onClose: function () { setChatOpen(false); },
        }) : null);
    }

    /* ───────────────────────── 插件导出 ───────────────────────── */

    /* 选文件夹：桌面端有 Electron 原生桥就用它，否则用 DSH 工作区的选择能力。
     * 两者都没有（例如纯浏览器打开）时返回 null，界面自动退回手输路径。
     */
    function resolvePickFolder(ctx) {
      var bridge = null;
      try {
        bridge = (typeof globalThis !== "undefined" && globalThis.__DSH_DIRECTORY_PICKER__) || null;
      } catch (ignore) { bridge = null; }
      if (bridge && typeof bridge.pick === "function") {
        return function () {
          try {
            return Promise.resolve(bridge.pick());
          } catch (failure) {
            return Promise.reject(failure);
          }
        };
      }
      var workspace = null;
      try { workspace = ctx && ctx.uiWorkspace; } catch (ignore) { workspace = null; }
      if (workspace && typeof workspace.pickDirectory === "function") {
        return function (title) {
          try {
            return Promise.resolve(workspace.pickDirectory(title));
          } catch (failure) {
            return Promise.reject(failure);
          }
        };
      }
      return null;
    }

    function apply(ctx) {
      try {
        ensureStyle();
        installDenyNotice();
        var authorReady = installAuthorChip(ctx);
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") return;
        var pickFolder = resolvePickFolder(ctx);
        ctx.slots.inject("conversation.input.right", function () {
          return ctx.slots.register({
            name: "conversation.input.right",
            id: "dsh-room",
            order: 45,
            label: "房间联机",
            inject: function () { return { pickFolder: pickFolder }; },
          }, RoomButton);
        });
        try { console.info("[dsh-room] 已挂载：conversation.input.right" + (pickFolder ? "（可用系统目录选择器）" : "（环境没有目录选择器，路径需手输）")); } catch (ignore) { /* 忽略 */ }
      } catch (error) {
        try { console.error("[dsh-room] 插槽注册失败，联机按钮不会出现：", error); } catch (ignore) { /* 忽略 */ }
      }
    }

    module.exports = {
      apply: apply,
      inject: ["slots"],
      // 仅给离线冒烟测试用；DSH 加载时会忽略多余字段。
      __test: {
        Panel: Panel,
        HostView: HostView,
        ChatPanel: ChatPanel,
        GuestView: GuestView,
        Select: Select,
        MemberList: MemberList,
        AddressList: AddressList,
        Tree: Tree,
        Icon: Icon,
        normalizeAddr: normalizeAddr,
        initialsOf: initialsOf,
        installDenyNotice: installDenyNotice,
        installAuthorChip: installAuthorChip,
        authorRule: authorRule,
        AuthorChip: AuthorChip,
        AUTHOR_NODE_ID: AUTHOR_NODE_ID,
        showDenyNotice: showDenyNotice,
        denyNoticeFor: denyNoticeFor,
        DENY_TITLES: DENY_TITLES,
        copyText: copyText,
        copyViaSelection: copyViaSelection,
        showManualCopy: showManualCopy,
        currentOrigin: currentOrigin,
        resolvePickFolder: resolvePickFolder,
      },
    };
    return module.exports;
  },
});
