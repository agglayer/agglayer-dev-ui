// Inline CSS for the HTML report (S54, heavy-load design §4.1). Static text: no
// dynamic value is ever interpolated into it, no `url()`, no `@import`.
//
// Tokens follow the dataviz reference palette (validated categorical slots,
// status colours, chart ink and surfaces); light is the base, dark redefines the
// same tokens under `prefers-color-scheme` and `[data-theme]`, print forces light.
export const REPORT_CSS = `
:root {
  color-scheme: light;
  --plane: #f4f4f1;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink2: #52514e;
  --muted: #76746e;
  --grid: #e1e0d9;
  --axis: #b5b4aa;
  --hair: rgba(11, 11, 11, 0.12);
  --accent: #1c5cab;
  --good: #0ca30c;
  --good-ink: #006300;
  --warn: #fab219;
  --warn-ink: #7a5200;
  --serious: #ec835a;
  --bad: #d03b3b;
  --bad-ink: #a32525;
  --tint-good: #e3f4e3;
  --tint-warn: #fdf1d3;
  --tint-bad: #fbe6e6;
  --tint-none: #ebeae5;
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100;
  --s5: #e87ba4; --s6: #008300; --s7: #6250d6; --s8: #e34948;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --plane: #0d0d0d;
    --surface: #1a1a19;
    --ink: #f0efec;
    --ink2: #c3c2b7;
    --muted: #9b9a92;
    --grid: #2c2c2a;
    --axis: #4a4a46;
    --hair: rgba(255, 255, 255, 0.12);
    --accent: #6da7ec;
    --good-ink: #5fd35f;
    --warn-ink: #fab219;
    --bad-ink: #ff8a8a;
    --tint-good: #12301a;
    --tint-warn: #33290a;
    --tint-bad: #3a1616;
    --tint-none: #262624;
    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500;
    --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --plane: #0d0d0d;
  --surface: #1a1a19;
  --ink: #f0efec;
  --ink2: #c3c2b7;
  --muted: #9b9a92;
  --grid: #2c2c2a;
  --axis: #4a4a46;
  --hair: rgba(255, 255, 255, 0.12);
  --accent: #6da7ec;
  --good-ink: #5fd35f;
  --warn-ink: #fab219;
  --bad-ink: #ff8a8a;
  --tint-good: #12301a;
  --tint-warn: #33290a;
  --tint-bad: #3a1616;
  --tint-none: #262624;
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500;
  --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767;
}
* { box-sizing: border-box; }
html { background: var(--plane); }
body {
  margin: 0; background: var(--plane); color: var(--ink);
  font: 14px/1.5 var(--font); -webkit-text-size-adjust: 100%;
  padding-block: 0 56px;
  padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px));
}
.wrap { max-width: 1180px; margin: 0 auto; }
h1, h2, h3 { text-wrap: balance; line-height: 1.2; margin: 0; }
h2 { font-size: 18px; letter-spacing: -0.01em; }
h3 { font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink2); font-weight: 650; margin: 22px 0 8px; }
p { margin: 8px 0; max-width: 78ch; }
code, .mono { font-family: var(--mono); font-size: 12.5px; }
a { color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* verdict banner */
.banner { display: flex; gap: 0; margin: 16px 0 0; border: 1px solid var(--hair); background: var(--surface); border-radius: 10px; overflow: hidden; }
.stamp { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; min-width: 150px; padding: 18px 16px; font-weight: 800; letter-spacing: 0.08em; font-size: 20px; text-align: center; }
.stamp svg { width: 30px; height: 30px; }
.stamp.pass { background: var(--tint-good); color: var(--good-ink); }
.stamp.fail { background: var(--tint-bad); color: var(--bad-ink); }
.stamp.incomplete, .stamp.aborted { background: var(--tint-warn); color: var(--warn-ink); }
.stamp.nolaps { background: var(--tint-none); color: var(--ink2); }
.banner-main { padding: 16px 20px; min-width: 0; flex: 1; }
.verdict-line { font-size: 17px; font-weight: 650; margin: 0 0 4px; max-width: none; overflow-wrap: anywhere; }
.rates { display: flex; flex-wrap: wrap; gap: 6px 22px; margin: 6px 0 10px; color: var(--ink2); }
.rates b { color: var(--ink); font-variant-numeric: tabular-nums; }
.identity { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 6px 24px; margin: 10px 0 0; padding: 10px 0 0; border-top: 1px solid var(--hair); }
.identity div { min-width: 0; }
.identity dt { font-size: 11px; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); }
.identity dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.gonogo { color: var(--ink2); font-size: 12.5px; margin: 10px 0 0; }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 1px 9px; border-radius: 99px; font-size: 12px; font-weight: 650; border: 1px solid var(--hair); background: var(--tint-none); color: var(--ink2); white-space: nowrap; }
.chip.good { background: var(--tint-good); color: var(--good-ink); }
.chip.bad { background: var(--tint-bad); color: var(--bad-ink); }
.chip.warn { background: var(--tint-warn); color: var(--warn-ink); }
.dropped { margin: 14px 0 0; padding: 10px 14px; border: 1px solid var(--hair); border-radius: 8px; background: var(--tint-warn); color: var(--warn-ink); }

nav.toc { display: flex; flex-wrap: wrap; gap: 6px; margin: 14px 0 6px; padding: 0; }
nav.toc a { text-decoration: none; font-size: 12.5px; padding: 3px 10px; border: 1px solid var(--hair); border-radius: 99px; background: var(--surface); color: var(--ink2); }
nav.toc a:hover { color: var(--accent); border-color: var(--accent); }

/* KPI cards */
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(176px, 1fr)); gap: 10px; margin: 12px 0 0; }
.kpi { background: var(--surface); border: 1px solid var(--hair); border-radius: 8px; padding: 11px 13px; min-width: 0; break-inside: avoid; }
.kpi .label { font-size: 11px; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); }
.kpi .value { font-size: 24px; font-weight: 650; letter-spacing: -0.01em; line-height: 1.15; margin-top: 3px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.kpi .value.na { color: var(--muted); font-weight: 500; }
.kpi .sub { font-size: 12px; color: var(--ink2); margin-top: 2px; overflow-wrap: anywhere; }
.kpi.bad .value { color: var(--bad-ink); }
.kpi.good .value { color: var(--good-ink); }

/* sections */
section.panel { margin-top: 30px; min-width: 0; }
section.panel > h2 { padding-bottom: 8px; border-bottom: 1px solid var(--hair); margin-bottom: 4px; }
.note { color: var(--ink2); font-size: 12.5px; }
.empty { color: var(--ink2); background: var(--tint-none); border: 1px dashed var(--axis); border-radius: 8px; padding: 10px 14px; margin: 10px 0; }
.finding { background: var(--tint-warn); color: var(--ink); border: 1px solid var(--hair); border-radius: 8px; padding: 10px 14px; margin: 10px 0; }
.finding b { color: var(--warn-ink); }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 18px; }
.cols > * { min-width: 0; }

/* tables */
.tablewrap { overflow-x: auto; margin: 8px 0; border: 1px solid var(--hair); border-radius: 8px; background: var(--surface); }
table.data { border-collapse: collapse; width: 100%; font-size: 13px; }
table.data th, table.data td { padding: 6px 11px; text-align: left; border-bottom: 1px solid var(--grid); white-space: nowrap; }
table.data td.wrapcell { white-space: normal; min-width: 150px; overflow-wrap: anywhere; }
table.data.compact th, table.data.compact td { padding: 3px 8px; }
table.data.compact th { white-space: normal; vertical-align: bottom; }
table.data.compact td.wrapcell { min-width: 110px; }
table.data th { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 650; background: var(--surface); }
table.data th.sorted::after { content: " \\2193"; }
table.data th.sorted.asc::after { content: " \\2191"; }
table.data th[role="button"] { cursor: pointer; }
table.data td.num, table.data th.num { text-align: right; font-variant-numeric: tabular-nums; }
table.data tbody tr:hover { background: var(--tint-none); }
table.data tbody tr:last-child td { border-bottom: 0; }
table.data tr.total td { font-weight: 650; border-top: 1px solid var(--axis); }
table.data .bad { color: var(--bad-ink); font-weight: 650; }
table.data .good { color: var(--good-ink); font-weight: 650; }
table.data .muted { color: var(--muted); }
details { margin: 10px 0; }
summary { cursor: pointer; color: var(--ink2); font-weight: 600; }
.kv { display: grid; grid-template-columns: minmax(150px, 230px) 1fr; gap: 3px 16px; margin: 6px 0; }
.kv dt { color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
.kv dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.meterbar { display: block; width: 100%; max-width: 520px; height: auto; margin: 6px 0; }
.meterbar .track { fill: var(--grid); }
.meterbar .fill { fill: var(--s1); }
.meterbar.over .fill { fill: var(--bad); }
section.panel.first { margin-top: 0; }

/* charts */
.chart-wrap { overflow-x: auto; margin: 8px 0; background: var(--surface); border: 1px solid var(--hair); border-radius: 8px; padding: 6px; }
.chart-wrap.tallwrap { max-height: 640px; overflow-y: auto; }
svg.chart { display: block; width: 100%; min-width: 640px; height: auto; font-family: var(--font); }
svg.chart text { fill: var(--muted); font-size: 11.5px; }
svg.chart text.lbl { fill: var(--ink); font-size: 12px; }
svg.chart text.val { fill: var(--ink); font-size: 11.5px; font-weight: 650; font-variant-numeric: tabular-nums; }
svg.chart text.thr { fill: var(--ink2); }
svg.chart .grid { stroke: var(--grid); stroke-width: 1; }
svg.chart .axis, svg.chart .tick { stroke: var(--axis); stroke-width: 1; }
svg.chart .vline { stroke: var(--ink2); stroke-width: 1.5; stroke-dasharray: 5 4; }
svg.chart .thresh { stroke: var(--bad); stroke-width: 1.5; stroke-dasharray: 6 4; }
svg.chart .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
svg.chart .band { opacity: 0.14; }
svg.chart .line.dashed { stroke-dasharray: 7 5; }
svg.chart .dot { stroke: var(--surface); stroke-width: 2; }
svg.chart .hit { fill: transparent; }
svg.chart .hit:hover { fill: var(--ink); fill-opacity: 0.06; }
svg.chart .pt { opacity: 0.6; stroke: var(--surface); stroke-width: 1; }
svg.chart .range { stroke: var(--ink2); stroke-width: 1.5; }
svg.chart .cap { stroke: var(--ink2); stroke-width: 1.5; }
svg.chart .p90 { fill: var(--surface); stroke: var(--ink); stroke-width: 2; }
svg.chart .median { stroke: var(--ink); stroke-width: 3; }
svg.chart .leaf-tick { stroke: var(--ink2); stroke-width: 1.5; }
svg.chart .pump-mark { fill: var(--s7); }
svg.chart rect.open { opacity: 0.45; }
.f1 { fill: var(--s1); } .f2 { fill: var(--s2); } .f3 { fill: var(--s3); } .f4 { fill: var(--s4); }
.f5 { fill: var(--s5); } .f6 { fill: var(--s6); } .f7 { fill: var(--s7); } .f8 { fill: var(--s8); }
.k1 { stroke: var(--s1); } .k2 { stroke: var(--s2); } .k3 { stroke: var(--s3); } .k4 { stroke: var(--s4); }
.k5 { stroke: var(--s5); } .k6 { stroke: var(--s6); } .k7 { stroke: var(--s7); } .k8 { stroke: var(--s8); }
.fcrit { fill: var(--bad); } .kcrit { stroke: var(--bad); } .fmuted { fill: var(--axis); }
.legend { display: flex; flex-wrap: wrap; gap: 4px 16px; list-style: none; margin: 8px 0 0; padding: 0; font-size: 12.5px; color: var(--ink2); }
.legend li { display: inline-flex; align-items: center; gap: 6px; }
.sw { width: 12px; height: 12px; }
.log-view { display: none; }
.is-log .lin-view { display: none; }
.is-log .log-view { display: block; }
.axisbtn { font: inherit; font-size: 12px; padding: 2px 10px; border: 1px solid var(--axis); border-radius: 6px; background: var(--surface); color: var(--ink2); cursor: pointer; margin: 4px 0; }
.axisbtn[aria-pressed="true"] { background: var(--ink); color: var(--surface); }
footer { margin-top: 36px; color: var(--muted); font-size: 12px; }

@media (max-width: 560px) {
  .banner { flex-direction: column; }
  .stamp { flex-direction: row; justify-content: flex-start; min-width: 0; padding: 12px 16px; }
  .kv { grid-template-columns: 1fr; }
  .chart-wrap::before, .tablewrap::before { content: "Wide: swipe sideways"; display: block; position: sticky; left: 0; padding: 2px 8px; font-size: 11px; color: var(--muted); }
}
@media (forced-colors: active) {
  .stamp, .chip, .kpi { border: 1px solid CanvasText; }
}
@media print {
  :root, :root[data-theme="dark"] {
    color-scheme: light;
    --plane: #fff; --surface: #fff; --ink: #000; --ink2: #333; --muted: #555; --grid: #ddd; --axis: #999;
    --hair: rgba(0, 0, 0, 0.2); --accent: #1c5cab; --good-ink: #006300; --warn-ink: #7a5200; --bad-ink: #a32525;
    --tint-good: #e3f4e3; --tint-warn: #fdf1d3; --tint-bad: #fbe6e6; --tint-none: #ebeae5;
    --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300; --s7: #6250d6; --s8: #e34948;
  }
  body { padding-block: 0; font-size: 11.5px; }
  nav.toc, .axisbtn { display: none; }
  .kpi, .chart-wrap, .tablewrap, .banner, .finding, .empty { break-inside: avoid; }
  section.panel { break-inside: auto; }
  section.panel > h2 { break-after: avoid; }
  .chart-wrap, .tablewrap { overflow: visible; }
  .chart-wrap.tallwrap { max-height: none; overflow: visible; }
  svg.chart { min-width: 0; }
  table.data th, table.data td { white-space: normal; }
  .log-view { display: none !important; }
  .is-log .lin-view { display: block !important; }
  table.data th[role="button"] { cursor: default; }
}
`;
