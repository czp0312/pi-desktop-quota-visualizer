export const CSS = `
.sq-overlay,.sq-launch {
  --sq-ink:#000;--sq-muted:#666;--sq-line:rgba(69,103,98,.12);
  --sq-surface:#fff;--sq-card:#fff;
  --sq-button:rgba(255,255,255,.6);--sq-hover:rgba(225,241,236,.86);
  --sq-track:rgba(76,116,107,.12);--sq-accent:#328d7c;
  --sq-shadow:0 18px 64px -22px rgba(28,66,57,.26),0 3px 12px rgba(28,66,57,.06);
  font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  color:var(--sq-ink);font-variant-numeric:tabular-nums;
}
.sq-launch,.sq-launch:hover,.sq-launch[aria-expanded=true]{font-size:12px;font-weight:400;border:0;border-radius:5px;background:transparent;box-shadow:none;padding:6px 4px;cursor:pointer}
.sq-overlay {position:fixed;inset:0;display:flex;align-items:flex-end;justify-content:flex-end;padding:20px;pointer-events:none;font-size:13px}
.sq-dialog {pointer-events:auto;background:var(--sq-surface);border:1px solid var(--sq-line);border-radius:22px;width:min(404px,calc(100vw - 40px));max-height:calc(100dvh - 60px);display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;box-shadow:var(--sq-shadow);animation:sq-fade-in 180ms ease-out}
@keyframes sq-fade-in{from{opacity:0}to{opacity:1}}
.sq-dialog.sq-closing{animation:sq-fade-out 180ms ease-in forwards;pointer-events:none}
@keyframes sq-fade-out{from{opacity:1}to{opacity:0}}
.sq-dialog *{box-sizing:border-box}
.sq-head {display:flex;align-items:center;justify-content:space-between;gap:10px;padding:17px 19px 13px;flex-shrink:0}
.sq-head h2 {font-size:15px;font-weight:650;letter-spacing:-.3px;margin:0}
.sq-icon{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:28px;height:28px;padding:5px;border:0;border-radius:7px;background:transparent;color:var(--sq-ink);cursor:pointer}
.sq-icon svg{display:block;width:16px;height:16px;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.sq-icon:hover:not(:disabled){background:var(--sq-hover)}
.sq-icon:disabled{opacity:.5;cursor:wait}
.sq-icon:focus-visible,.sq-launch:focus-visible,.sq-picker select:focus-visible{outline:2px solid var(--sq-accent);outline-offset:3px}
.sq-head-tools{display:flex;align-items:center;gap:4px;flex-shrink:0}.sq-head-tools>span{white-space:nowrap}
.sq-dialog:focus{outline:none}
.sq-body {padding:0 12px 12px;overflow-y:auto;min-height:0;scrollbar-width:thin;scrollbar-color:rgba(99,131,123,.3) transparent}
.sq-account {padding:14px 15px 9px;border:1px solid var(--sq-line);border-radius:15px;background:var(--sq-card);margin-bottom:9px}
.sq-account:last-child{margin-bottom:0}
.sq-account h3 {margin:0 0 13px;font-size:12px;font-weight:650;line-height:1.5;overflow-wrap:anywhere;letter-spacing:-.1px}
.sq-meter {margin:0 0 13px}.sq-line {display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px}
.sq-line>span:first-child{color:var(--sq-muted)}
.sq-value {font-size:12px;font-weight:650;letter-spacing:-.2px;white-space:nowrap}
.sq-bar{height:6px;background:var(--sq-track);margin:7px 0 5px;border-radius:999px;overflow:hidden}
.sq-fill{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#63b7a0,#359b8b);transition:width .35s ease}
.sq-meter[data-tone=low] .sq-fill{background:linear-gradient(90deg,#dfba6d,#c69a45)}
.sq-meter[data-tone=critical] .sq-fill{background:linear-gradient(90deg,#e8a092,#d27b6b)}
.sq-meter[data-tone=low] .sq-value,.sq-meter[data-tone=critical] .sq-value{color:var(--sq-ink)}
.sq-muted{color:var(--sq-muted);font-size:10px;line-height:1.6}.sq-empty {padding:12px 8px;line-height:1.7;color:var(--sq-muted);font-size:12px}
.sq-error{color:#b35e51;overflow-wrap:anywhere;font-size:12px;padding:0 5px}
@media(prefers-color-scheme:dark){
  .sq-launch {--sq-ink:#f5f5f5;--sq-muted:#aaa}
}
.sq-picker{padding:0 19px 10px;flex-shrink:0}
.sq-picker label{display:block;font-size:11px;font-weight:600;margin-bottom:6px}
.sq-picker select{width:100%;min-width:0;box-sizing:border-box;font:inherit;font-size:12px;color:var(--sq-ink);background:var(--sq-card);border:1px solid var(--sq-line);border-radius:9px;padding:8px 10px;color-scheme:light}
.sq-picker p{margin:5px 0 0}
@media(max-width:460px){.sq-overlay{padding:10px}.sq-dialog{width:calc(100vw - 20px);max-height:calc(100dvh - 40px);border-radius:19px}.sq-head{padding:15px}}
@media(prefers-reduced-motion:reduce){.sq-dialog,.sq-dialog.sq-closing{animation:none}.sq-fill,.sq-icon,.sq-launch{transition:none}}
`;
