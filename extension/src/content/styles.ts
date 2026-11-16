export const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.panel {
  position: fixed; top: 12px; right: 12px; width: 430px; max-height: calc(100vh - 24px);
  display: flex; flex-direction: column; z-index: 2147483647;
  background: #14161f; color: #e6e8f5; border: 1px solid #343a63; border-radius: 12px;
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 12px 40px rgba(0,0,0,.5);
}
.hdr { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #262a45; }
.hdr h1 { font-size: 14px; margin: 0; flex: 1; color: #a8b0ff; }
.x { background: none; border: 0; color: #8b92c9; font-size: 18px; cursor: pointer; line-height: 1; }
.x:hover { color: #fff; }
.bar { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 12px; align-items: center; }
button.btn, select, input.filter {
  background: #20243a; color: #e6e8f5; border: 1px solid #343a63; border-radius: 8px;
  padding: 6px 10px; font: inherit; cursor: pointer;
}
button.btn:hover { background: #2a2f4d; }
button.btn.primary { background: #5b63d6; border-color: #5b63d6; color: #fff; }
button.btn.on { background: #1e7a5a; border-color: #1e7a5a; color: #fff; }
button.btn:disabled { opacity: .5; cursor: default; }
select { padding: 5px 8px; }
input.filter { width: 100%; cursor: text; }
.status { padding: 0 12px 8px; color: #9aa1d4; font-size: 12px; min-height: 18px; }
.status.err { color: #ff8b8b; }
.body { overflow: auto; padding: 0 12px 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.chip { background: #232846; border: 1px solid #343a63; border-radius: 999px; padding: 1px 9px; font-size: 11px; color: #b9bff5; }
.chip.btnchip { cursor: pointer; }
.chip.btnchip.on { background: #5b63d6; border-color: #5b63d6; color: #fff; }
.el { margin: 10px 0 6px; font-size: 14px; word-break: break-word; }
.tag { color: #7fb4ff; font-family: ui-monospace, Consolas, monospace; }
.dim { color: #8b92c9; }
.rec { background: #11261f; border: 1px solid #1e5a43; border-radius: 10px; padding: 10px; margin: 8px 0; }
.rec .lbl { font-size: 11px; color: #5fd1a1; text-transform: uppercase; letter-spacing: .04em; }
.code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-all; white-space: pre-wrap; }
.row { display: flex; gap: 8px; align-items: flex-start; padding: 7px 0; border-top: 1px solid #22263f; }
.row .main { flex: 1; min-width: 0; }
.row .meta { color: #8b92c9; font-size: 11px; margin-bottom: 2px; }
.score { min-width: 34px; text-align: center; border-radius: 6px; padding: 1px 4px; font-weight: 600; font-size: 12px; }
.s-hi { background: #12372a; color: #5fd1a1; } .s-mid { background: #3b3216; color: #f0c05a; } .s-lo { background: #3d1c1c; color: #ff8b8b; }
.m-ok { color: #5fd1a1; } .m-warn { color: #f0c05a; } .m-bad { color: #ff8b8b; } .m-none { color: #8b92c9; }
.copy { background: none; border: 1px solid #343a63; color: #b9bff5; border-radius: 6px; padding: 2px 8px; font: inherit; font-size: 11px; cursor: pointer; }
.copy:hover { background: #2a2f4d; }
.item { border: 1px solid #262a45; border-radius: 10px; margin: 8px 0; }
.item > .head { display: flex; gap: 8px; align-items: center; padding: 8px 10px; cursor: pointer; }
.item > .head:hover { background: #1b1f33; border-radius: 10px; }
.item .t { flex: 1; min-width: 0; }
.item .t .loc { color: #9fe3c5; font-family: ui-monospace, Consolas, monospace; font-size: 11px; word-break: break-all; }
.item > .detail { padding: 0 10px 8px; }
pre.po { background: #0c0e16; border: 1px solid #262a45; border-radius: 8px; padding: 10px; max-height: 260px; overflow: auto; margin: 8px 0 4px; }
.hl { position: fixed; pointer-events: none; z-index: 2147483646; border: 2px solid #7c83ff; background: rgba(124,131,255,.18); border-radius: 3px; display: none; }
.note { color: #8b92c9; font-size: 12px; margin: 8px 0; }
`;
