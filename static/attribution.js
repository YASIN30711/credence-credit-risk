"use strict";

/* ============================================================
   Credence — full feature-attribution page
   Front-end only. The main page parks the scored payload(s) in
   localStorage; this page re-requests POST /explain for each one
   and draws the SHAP values as bar / donut / waterfall / compare.
   Nothing is estimated here — every number is from the API.
   ============================================================ */

const EXPLAIN_URL = "/explain";
const STORAGE_KEY = "credence.attribution.v1";
const REQUEST_TIMEOUT_MS = 30000;

const SCENARIO_COLORS = ["#F4F1FA", "#38bdf8", "#f5b84b", "#c084fc", "#8A839C"];
const SVG_NS = "http://www.w3.org/2000/svg";

/* ---------- field metadata (mirrors the main page's schema) ---------- */

const OPTION_LABELS = {
  person_home_ownership: { MORTGAGE: "Mortgage", RENT: "Rent", OWN: "Owns outright", OTHER: "Other" },
  loan_intent: {
    DEBTCONSOLIDATION: "Debt consolidation", EDUCATION: "Education", HOMEIMPROVEMENT: "Home improvement",
    MEDICAL: "Medical", PERSONAL: "Personal", VENTURE: "Venture / business",
  },
  cb_person_default_on_file: { Y: "Default on file", N: "Clean record" },
};

const FEATURE_META = {
  person_age: { label: "Age", unit: "years" },
  person_income: { label: "Annual income", money: true },
  person_home_ownership: { label: "Housing status" },
  person_emp_length: { label: "Employment length", unit: "years" },
  loan_intent: { label: "Purpose" },
  loan_grade: { label: "Loan grade" },
  loan_amnt: { label: "Loan amount", money: true },
  loan_int_rate: { label: "Interest rate", unit: "%" },
  loan_percent_income: { label: "Loan-to-income ratio", ratio: true },
  cb_person_default_on_file: { label: "Default on record" },
  cb_person_cred_hist_length: { label: "Credit history length", unit: "years" },
};

const featureLabel = (name) => FEATURE_META[name]?.label ?? name;

function formatFeatureValue(name, value, currency) {
  if (value === null || value === undefined) return "";
  const meta = FEATURE_META[name] ?? {};
  if (meta.money) {
    const local = Number(value) * (currency?.rate ?? 1);
    return `${currency?.symbol ?? "$"}${local.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  }
  if (OPTION_LABELS[name]) return OPTION_LABELS[name][value] ?? String(value);
  if (meta.ratio) return Number(value).toFixed(4);
  if (meta.unit === "years") return `${Number(value)} yrs`;
  if (meta.unit === "%") return `${Number(value)}%`;
  return String(value);
}

/* ---------- tiny DOM helpers (text only — no innerHTML with data) ---------- */

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (value === true) node.setAttribute(key, "");
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

function svg(tag, attrs, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) if (child) node.append(child);
  return node;
}

const fmtSigned = (n, d = 3) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(d)}`;
const fmtPct = (n, d = 1) => `${(n * 100).toFixed(d)}%`;
const fmtSignedPct = (n, d = 1) => `${n >= 0 ? "+" : "−"}${Math.abs(n * 100).toFixed(d)}%`;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- state ---------- */

const VIEWS = [
  { id: "bar", label: "Bar chart" },
  { id: "donut", label: "Donut" },
  { id: "waterfall", label: "Waterfall" },
  { id: "compare", label: "Compare" },
];

const ui = {
  view: "bar",
  scenario: 0,
  topN: 8,            // 5 | 8 | 0 (= all)
  units: "logodds",   // "logodds" | "share"
  compareMode: "values", // "values" | "delta"
};

let scenarios = [];   // [{label, payload, response, currency, explain, error}]
let root = null;

/* ---------- data prep ---------- */

function loadHandoff() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.scenarios) ? parsed.scenarios.filter((s) => s?.payload) : [];
  } catch {
    return [];
  }
}

async function fetchExplanation(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(EXPLAIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = null;
      try { detail = JSON.parse(text)?.detail; } catch { /* non-JSON */ }
      const error = new Error(typeof detail === "string" ? detail : `Status ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const data = JSON.parse(text);
    if (!Array.isArray(data?.shap_values)) throw new Error("Unexpected response shape");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Sort by impact and fold the tail into one "Other" row so sums stay exact. */
function prepareRows(items, topN) {
  const sorted = [...items].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  if (!topN || sorted.length <= topN + 1) return sorted.map((item) => ({ ...item, label: featureLabel(item.feature) }));
  const head = sorted.slice(0, topN);
  const tail = sorted.slice(topN);
  return [
    ...head.map((item) => ({ ...item, label: featureLabel(item.feature) })),
    {
      feature: "__other__",
      label: `Other ${tail.length} features`,
      value: null,
      contribution: tail.reduce((sum, item) => sum + item.contribution, 0),
      members: tail,
    },
  ];
}

function totalsFor(explain) {
  const items = explain.shap_values;
  const totalAbs = items.reduce((sum, item) => sum + Math.abs(item.contribution), 0) || 1e-9;
  const net = items.reduce((sum, item) => sum + item.contribution, 0);
  const up = items.filter((i) => i.contribution > 0).reduce((s, i) => s + i.contribution, 0);
  const down = items.filter((i) => i.contribution < 0).reduce((s, i) => s + i.contribution, 0);
  return { totalAbs, net, up, down, base: explain.base_value, output: explain.base_value + net };
}

function amount(contribution, totalAbs) {
  return ui.units === "share" ? fmtSignedPct(contribution / totalAbs) : fmtSigned(contribution);
}

/* ---------- tooltip ---------- */

const tip = document.getElementById("attrTip");

function showTip(target, lines) {
  tip.replaceChildren(
    el("strong", null, lines.title),
    ...lines.rows.map(([k, v]) => el("div", { class: "tip-row" }, el("span", null, k), el("span", { class: "mono" }, v)))
  );
  tip.hidden = false;
  moveTipTo(target);
}
function moveTipTo(target, event) {
  const rect = target.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let x = event ? event.clientX + 14 : rect.left + rect.width / 2 - tipRect.width / 2;
  let y = event ? event.clientY + 16 : rect.bottom + 8;
  x = Math.max(8, Math.min(x, window.innerWidth - tipRect.width - 8));
  if (y + tipRect.height > window.innerHeight - 8) y = (event ? event.clientY : rect.top) - tipRect.height - 12;
  tip.style.left = `${x + window.scrollX}px`;
  tip.style.top = `${y + window.scrollY}px`;
}
function hideTip() { tip.hidden = true; }

function bindTip(node, getLines) {
  node.addEventListener("mouseenter", (e) => showTip(node, getLines()) || moveTipTo(node, e));
  node.addEventListener("mousemove", (e) => moveTipTo(node, e));
  node.addEventListener("mouseleave", hideTip);
  node.addEventListener("focus", () => showTip(node, getLines()));
  node.addEventListener("blur", hideTip);
}

function rowTip(row, scenario, totals) {
  return () => ({
    title: row.label,
    rows: [
      ...(row.value !== null && row.value !== undefined ? [["Applicant value", formatFeatureValue(row.feature, row.value, scenario.currency)]] : []),
      ["Contribution", `${fmtSigned(row.contribution)} log-odds`],
      ["Share of influence", fmtSignedPct(row.contribution / totals.totalAbs)],
      ["Effect", row.contribution >= 0 ? "Increases risk" : "Decreases risk"],
    ],
  });
}

/* ---------- view: bar chart ---------- */

function renderBar(scenario) {
  const totals = totalsFor(scenario.explain);
  const rows = prepareRows(scenario.explain.shap_values, ui.topN);
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.contribution)), 1e-9);

  const list = el("div", { class: "bc-rows", role: "list" });
  rows.forEach((row) => {
    const up = row.contribution >= 0;
    const width = (Math.abs(row.contribution) / maxAbs) * 50;
    const item = el("div", { class: "bc-row", role: "listitem", tabindex: "0",
      "aria-label": `${row.label}: ${fmtSigned(row.contribution)} log-odds, ${up ? "increases" : "decreases"} risk` },
      el("div", { class: "bc-meta" },
        el("span", { class: "bc-name" }, row.label),
        el("span", { class: "bc-val mono" }, formatFeatureValue(row.feature, row.value, scenario.currency))),
      el("div", { class: "bc-track" },
        el("span", { class: "bc-axis" }),
        el("span", { class: `bc-bar ${up ? "up" : "down"}`, style: `width:${Math.max(width, 0.6)}%` })),
      el("span", { class: `bc-num mono ${up ? "up" : "down"}` }, amount(row.contribution, totals.totalAbs)));
    bindTip(item, rowTip(row, scenario, totals));
    list.append(item);
  });

  return el("div", { class: "chart-card" },
    el("div", { class: "bc-scale", "aria-hidden": "true" },
      el("span"),
      el("div", { class: "bc-scale-track" },
        el("span", { class: "lg-down" }, "◀ decreases risk"),
        el("span", { class: "bc-zero mono" }, "0"),
        el("span", { class: "lg-up" }, "increases risk ▶")),
      el("span")),
    list,
    el("p", { class: "chart-note mono" },
      ui.units === "share"
        ? "bar length = share of this applicant’s total absolute influence"
        : "bar length = contribution to the risk score, in log-odds units"));
}

/* ---------- view: donut ---------- */

function shade(hue, sat, lightLow, lightHigh, i, n) {
  const t = n <= 1 ? 0 : i / (n - 1);
  return `hsl(${hue} ${sat}% ${lightLow + (lightHigh - lightLow) * t}%)`;
}

function arcPath(cx, cy, rOuter, rInner, a0, a1) {
  const pt = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = pt(rOuter, a0), [x1, y1] = pt(rOuter, a1);
  const [x2, y2] = pt(rInner, a1), [x3, y3] = pt(rInner, a0);
  return `M${x0} ${y0}A${rOuter} ${rOuter} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${rInner} ${rInner} 0 ${large} 0 ${x3} ${y3}Z`;
}

function renderDonut(scenario) {
  const totals = totalsFor(scenario.explain);
  const rows = prepareRows(scenario.explain.shap_values, ui.topN);
  const ups = rows.filter((r) => r.contribution >= 0);
  const downs = rows.filter((r) => r.contribution < 0);
  const ordered = [...ups, ...downs];
  ordered.forEach((row) => {
    const group = row.contribution >= 0 ? ups : downs;
    const i = group.indexOf(row);
    row.color = row.contribution >= 0
      ? shade(5, 62, 38, 70, i, group.length)
      : shade(150, 42, 27, 62, i, group.length);
    row.share = Math.abs(row.contribution) / totals.totalAbs;
  });

  const size = 260, cx = size / 2, cy = size / 2, rOuter = 118, rInner = 70;
  const chart = svg("svg", { viewBox: `0 0 ${size} ${size}`, class: "donut-svg", role: "img",
    "aria-label": "Donut chart of each feature's share of total influence" });
  let angle = -Math.PI / 2;
  const slices = new Map();
  ordered.forEach((row) => {
    const sweep = row.share * Math.PI * 2;
    const full = sweep >= Math.PI * 2 - 1e-6;
    const path = full
      ? svg("path", { d: `${arcPath(cx, cy, rOuter, rInner, angle, angle + Math.PI)}${arcPath(cx, cy, rOuter, rInner, angle + Math.PI, angle + Math.PI * 2 - 1e-4)}`, fill: row.color })
      : svg("path", { d: arcPath(cx, cy, rOuter, rInner, angle, angle + sweep), fill: row.color });
    path.setAttribute("class", "donut-slice");
    path.setAttribute("stroke", "var(--field-bg)");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("tabindex", "0");
    path.setAttribute("aria-label", `${row.label}: ${fmtPct(row.share)} of total influence, ${row.contribution >= 0 ? "increases" : "decreases"} risk`);
    slices.set(row, path);
    chart.append(path);
    angle += sweep;
  });

  const upShare = totals.up / totals.totalAbs;
  chart.append(
    svg("text", { x: cx, y: cy - 4, "text-anchor": "middle", class: "donut-big" }, document.createTextNode(`${Math.round(upShare * 100)}%`)),
    svg("text", { x: cx, y: cy + 16, "text-anchor": "middle", class: "donut-sub" }, document.createTextNode("pushes toward risk")));

  const legend = el("ul", { class: "donut-legend" });
  const rowNodes = new Map();
  ordered.forEach((row) => {
    const up = row.contribution >= 0;
    const li = el("li", { class: "dl-row", tabindex: "0" },
      el("span", { class: "dl-swatch", style: `background:${row.color}` }),
      el("span", { class: "dl-name" }, row.label,
        row.value !== null && row.value !== undefined
          ? el("span", { class: "dl-value mono" }, formatFeatureValue(row.feature, row.value, scenario.currency)) : null),
      el("span", { class: `dl-share mono ${up ? "up" : "down"}` }, fmtPct(row.share)),
      el("span", { class: "dl-contrib mono" }, `${fmtSigned(row.contribution)}`));
    rowNodes.set(row, li);
    legend.append(li);
  });

  const focusRow = (row, on) => {
    chart.classList.toggle("is-dimmed", on);
    slices.forEach((path, r) => path.classList.toggle("is-active", on && r === row));
    rowNodes.forEach((li, r) => li.classList.toggle("is-active", on && r === row));
  };
  ordered.forEach((row) => {
    [slices.get(row), rowNodes.get(row)].forEach((node) => {
      bindTip(node, rowTip(row, scenario, totals));
      node.addEventListener("mouseenter", () => focusRow(row, true));
      node.addEventListener("mouseleave", () => focusRow(row, false));
      node.addEventListener("focus", () => focusRow(row, true));
      node.addEventListener("blur", () => focusRow(row, false));
    });
  });

  return el("div", { class: "chart-card" },
    el("div", { class: "donut-wrap" },
      el("div", { class: "donut-figure" }, chart),
      el("div", { class: "donut-side" },
        el("div", { class: "donut-key" },
          el("span", { class: "lg-up" }, "▲ reds raise risk"),
          el("span", { class: "lg-down" }, "▼ greens lower risk")),
        legend)),
    el("p", { class: "chart-note mono" },
      "slice size = share of total absolute influence · a donut can’t show negative values, so direction is shown by colour"));
}

/* ---------- view: waterfall ---------- */

function niceStep(range) {
  const raw = range / 6;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const frac = raw / pow;
  return (frac < 1.5 ? 1 : frac < 3.5 ? 2 : frac < 7.5 ? 5 : 10) * pow;
}

function renderWaterfall(scenario) {
  const totals = totalsFor(scenario.explain);
  // Waterfall reads best from the biggest push down to the smallest.
  const rows = prepareRows(scenario.explain.shap_values, ui.topN);

  const steps = [];
  let running = totals.base;
  rows.forEach((row) => {
    steps.push({ row, from: running, to: running + row.contribution });
    running += row.contribution;
  });
  const values = [0, totals.base, totals.output, ...steps.flatMap((s) => [s.from, s.to])];
  let lo = Math.min(...values), hi = Math.max(...values);
  const pad = (hi - lo) * 0.08 || 0.5;
  lo -= pad; hi += pad;

  const W = 880, labelW = 210, rightPad = 86, top = 44, rowH = 38;
  const plotL = labelW, plotR = W - rightPad;
  const total = steps.length + 2;
  const H = top + total * rowH + 14;
  const x = (v) => plotL + ((v - lo) / (hi - lo)) * (plotR - plotL);

  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "wf-svg", role: "img",
    "aria-label": "Waterfall chart from the base value to the model output" });

  const step = niceStep(hi - lo);
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) {
    const tx = x(t);
    chart.append(
      svg("line", { x1: tx, x2: tx, y1: top - 8, y2: H - 10, class: Math.abs(t) < 1e-9 ? "wf-zero" : "wf-grid" }),
      svg("text", { x: tx, y: top - 16, "text-anchor": "middle", class: "wf-tick" }, document.createTextNode(Math.abs(t) < 1e-9 ? "0" : t.toFixed(step < 1 ? 1 : 0))));
  }

  const makeRow = (index, label, sub, from, to, cls, valueText, getLines) => {
    const y = top + index * rowH;
    const x0 = x(Math.min(from, to)), x1 = x(Math.max(from, to));
    const g = svg("g", { class: "wf-row", tabindex: "0", "aria-label": `${label}: ${valueText}` });
    g.append(
      svg("rect", { x: 0, y: y - 2, width: W, height: rowH - 2, class: "wf-hit" }),
      svg("text", { x: 0, y: y + 14, class: "wf-label" }, document.createTextNode(label)));
    if (sub) g.append(svg("text", { x: 0, y: y + 27, class: "wf-sub" }, document.createTextNode(sub)));
    g.append(
      svg("rect", { x: x0, y: y + 5, width: Math.max(x1 - x0, 2), height: rowH - 16, rx: 2, class: `wf-bar ${cls}` }),
      svg("text", { x: x1 + 8, y: y + 19, class: `wf-num ${cls}` }, document.createTextNode(valueText)));
    bindTip(g, getLines);
    chart.append(g);
    return y;
  };

  makeRow(0, "Base value", "average model output", 0, totals.base, "total", totals.base.toFixed(3), () => ({
    title: "Base value", rows: [["Average model output", `${totals.base.toFixed(3)} log-odds`]] }));

  steps.forEach((s, i) => {
    const up = s.row.contribution >= 0;
    const sub = s.row.value !== null && s.row.value !== undefined ? formatFeatureValue(s.row.feature, s.row.value, scenario.currency) : "";
    const y = makeRow(i + 1, s.row.label, sub, s.from, s.to, up ? "up" : "down", fmtSigned(s.row.contribution), rowTip(s.row, scenario, totals));
    chart.insertBefore(
      svg("line", { x1: x(s.from), x2: x(s.from), y1: y - 6, y2: y + 6, class: "wf-conn" }),
      chart.firstChild);
  });

  makeRow(steps.length + 1, "Model output", "base + all contributions", 0, totals.output, "total", totals.output.toFixed(3), () => ({
    title: "Model output f(x)",
    rows: [["Base value", totals.base.toFixed(3)], ["Net contributions", fmtSigned(totals.net)], ["Output", `${totals.output.toFixed(3)} log-odds`]] }));

  return el("div", { class: "chart-card" },
    el("div", { class: "wf-scroll" }, chart),
    el("p", { class: "chart-note mono" },
      "each bar starts where the previous one ended · red pushes the score up, green pulls it down · log-odds (0 = 50% probability)"));
}

/* ---------- view: compare ---------- */

function renderCompare() {
  if (scenarios.length < 2) {
    return el("div", { class: "chart-card empty-card" },
      el("h3", null, "Compare needs at least two scenarios"),
      el("p", null, "Run an assessment on the main page, press “Compare scenarios”, change a few inputs, and come back — every scenario will appear here side by side."),
      el("a", { class: "btn btn-primary", href: "/#assessment" }, "Go to the assessment"));
  }

  const delta = ui.compareMode === "delta";
  const names = scenarios[0].explain.shap_values.map((i) => i.feature);
  const lookup = scenarios.map((s) => new Map(s.explain.shap_values.map((i) => [i.feature, i])));
  const value = (sIdx, name) => {
    const c = lookup[sIdx].get(name)?.contribution ?? 0;
    return delta ? c - (lookup[0].get(name)?.contribution ?? 0) : c;
  };
  const shown = delta ? scenarios.map((_, i) => i).slice(1) : scenarios.map((_, i) => i);

  let rows = names.map((name) => ({
    name,
    rank: Math.max(...shown.map((i) => Math.abs(value(i, name)))),
  })).sort((a, b) => b.rank - a.rank);
  if (ui.topN && rows.length > ui.topN + 1) rows = rows.slice(0, ui.topN);
  const maxAbs = Math.max(...rows.flatMap((r) => shown.map((i) => Math.abs(value(i, r.name)))), 1e-9);

  const legend = el("div", { class: "cmp-legend" },
    scenarios.map((s, i) => el("span", { class: `cmp-chip${delta && i === 0 ? " is-base" : ""}` },
      el("span", { class: "cmp-dot", style: `background:${SCENARIO_COLORS[i % SCENARIO_COLORS.length]}` }),
      el("strong", null, s.label),
      el("span", { class: "mono" }, s.response?.default_probability != null ? `PD ${fmtPct(s.response.default_probability)}` : ""),
      s.response?.Result ? el("span", { class: `cmp-result ${/high/i.test(s.response.Result) ? "up" : "down"}` }, s.response.Result) : null,
      delta && i === 0 ? el("em", null, "baseline") : null)));

  const list = el("div", { class: "cmp-rows", role: "list" });
  rows.forEach(({ name }) => {
    const group = el("div", { class: "cmp-row", role: "listitem", tabindex: "0",
      "aria-label": `${featureLabel(name)} across ${shown.length} scenarios` },
      el("div", { class: "cmp-name" },
        el("span", { class: "bc-name" }, featureLabel(name)),
        el("span", { class: "bc-val mono" }, formatFeatureValue(name, lookup[0].get(name)?.value, scenarios[0].currency))),
      el("div", { class: "cmp-bars" },
        el("span", { class: "bc-axis" }),
        shown.map((i) => {
          const v = value(i, name);
          const w = (Math.abs(v) / maxAbs) * 50;
          const style = v >= 0 ? `left:50%;width:${Math.max(w, 0.4)}%` : `right:50%;width:${Math.max(w, 0.4)}%`;
          return el("div", { class: "cmp-line" },
            el("span", { class: `cmp-bar ${v >= 0 ? "pos" : "neg"}`, style: `${style};background:${SCENARIO_COLORS[i % SCENARIO_COLORS.length]}` }));
        })));
    bindTip(group, () => ({
      title: featureLabel(name),
      rows: scenarios.map((s, i) => {
        const raw = lookup[i].get(name);
        const val = formatFeatureValue(name, raw?.value, s.currency);
        const c = raw?.contribution ?? 0;
        const d = c - (lookup[0].get(name)?.contribution ?? 0);
        return [`${s.label} · ${val}`, i === 0 || !delta ? fmtSigned(c) : `${fmtSigned(c)} (Δ ${fmtSigned(d)})`];
      }),
    }));
    list.append(group);
  });

  return el("div", { class: "chart-card" },
    el("div", { class: "seg-row" },
      el("span", { class: "seg-label" }, "Show"),
      segmented("compare-mode", [["values", "Contributions"], ["delta", "Change vs Scenario A"]], ui.compareMode, (v) => { ui.compareMode = v; draw(); })),
    legend,
    el("div", { class: "bc-scale", "aria-hidden": "true" },
      el("span"),
      el("div", { class: "bc-scale-track" },
        el("span", { class: "lg-down" }, "◀ lowers risk"),
        el("span", { class: "bc-zero mono" }, "0"),
        el("span", { class: "lg-up" }, "raises risk ▶")),
      el("span")),
    list,
    el("p", { class: "chart-note mono" },
      delta
        ? "each bar = that scenario’s contribution minus Scenario A’s · colours identify scenarios, direction shows the sign"
        : "colours identify scenarios; bars to the right raise risk, bars to the left lower it · log-odds"));
}

/* ---------- controls ---------- */

function segmented(name, options, current, onChange) {
  const wrap = el("div", { class: "seg", role: "radiogroup", "aria-label": name });
  options.forEach(([value, label]) => {
    const active = String(value) === String(current);
    const button = el("button", { type: "button", class: `seg-btn${active ? " is-active" : ""}`,
      role: "radio", "aria-checked": active ? "true" : "false" }, label);
    button.addEventListener("click", () => onChange(value));
    wrap.append(button);
  });
  return wrap;
}

function renderControls() {
  const tabs = el("div", { class: "tabs", role: "tablist", "aria-label": "Chart type" },
    VIEWS.map((view) => {
      const active = ui.view === view.id;
      const tab = el("button", { type: "button", class: `tab${active ? " is-active" : ""}`, role: "tab",
        id: `tab-${view.id}`, "aria-selected": active ? "true" : "false", tabindex: active ? "0" : "-1" }, view.label);
      tab.addEventListener("click", () => { ui.view = view.id; history.replaceState(null, "", `#${view.id}`); draw(); });
      return tab;
    }));
  tabs.addEventListener("keydown", (event) => {
    if (!["ArrowRight", "ArrowLeft"].includes(event.key)) return;
    const index = VIEWS.findIndex((v) => v.id === ui.view);
    const next = VIEWS[(index + (event.key === "ArrowRight" ? 1 : VIEWS.length - 1)) % VIEWS.length];
    ui.view = next.id;
    history.replaceState(null, "", `#${next.id}`);
    draw();
    document.getElementById(`tab-${next.id}`)?.focus();
  });

  const options = el("div", { class: "options" });

  if (scenarios.length > 1 && ui.view !== "compare") {
    const select = el("select", { class: "attr-select", id: "scenarioSelect", "aria-label": "Scenario" },
      scenarios.map((s, i) => el("option", { value: String(i), selected: i === ui.scenario ? true : null }, s.label)));
    select.addEventListener("change", () => { ui.scenario = Number(select.value); draw(); });
    options.append(el("div", { class: "opt" }, el("span", { class: "seg-label" }, "Scenario"), select));
  }

  options.append(el("div", { class: "opt" }, el("span", { class: "seg-label" }, "Features"),
    segmented("Number of features", [[5, "Top 5"], [8, "Top 8"], [0, "All"]], ui.topN, (v) => { ui.topN = Number(v); draw(); })));

  if (ui.view === "bar") {
    options.append(el("div", { class: "opt" }, el("span", { class: "seg-label" }, "Units"),
      segmented("Units", [["logodds", "Log-odds"], ["share", "% of influence"]], ui.units, (v) => { ui.units = v; draw(); })));
  }

  return el("div", { class: "controls" }, tabs, options);
}

/* ---------- summary & table ---------- */

function renderSummary(scenario) {
  const t = totalsFor(scenario.explain);
  const r = scenario.response;
  const high = r?.Result && /high/i.test(r.Result);
  const stat = (label, value, hint, cls) => el("div", { class: `stat${cls ? ` ${cls}` : ""}` },
    el("span", { class: "stat-label" }, label),
    el("span", { class: "stat-value mono" }, value),
    hint ? el("span", { class: "stat-hint" }, hint) : null);
  return el("div", { class: "summary" },
    r?.default_probability != null
      ? stat("Probability of default", fmtPct(r.default_probability), r.Result ? `${r.Result}${r.threshold != null ? ` · threshold ${fmtPct(r.threshold)}` : ""}` : "", high ? "is-high" : "is-low")
      : null,
    stat("Base value", t.base.toFixed(3), "average model output"),
    stat("Pushes risk up", fmtSigned(t.up), "sum of red contributions", "is-high"),
    stat("Pulls risk down", fmtSigned(t.down), "sum of green contributions", "is-low"),
    stat("Model output", t.output.toFixed(3), "log-odds = base + contributions"));
}

function renderTable(scenario) {
  const totals = totalsFor(scenario.explain);
  const rows = prepareRows(scenario.explain.shap_values, 0);
  return el("details", { class: "table-details" },
    el("summary", null, "View the numbers as a table"),
    el("div", { class: "table-wrap" },
      el("table", null,
        el("thead", null, el("tr", null, ["Feature", "Applicant value", "Contribution (log-odds)", "Share of influence", "Effect"].map((h) => el("th", { scope: "col" }, h)))),
        el("tbody", null, rows.map((row) => el("tr", null,
          el("th", { scope: "row" }, row.label),
          el("td", null, formatFeatureValue(row.feature, row.value, scenario.currency)),
          el("td", { class: `mono ${row.contribution >= 0 ? "up" : "down"}` }, fmtSigned(row.contribution)),
          el("td", { class: "mono" }, fmtSignedPct(row.contribution / totals.totalAbs)),
          el("td", null, row.contribution >= 0 ? "Increases risk" : "Decreases risk")))))));
}

/* ---------- draw ---------- */

function draw() {
  hideTip();
  const scenario = scenarios[Math.min(ui.scenario, scenarios.length - 1)];
  const ready = scenarios.filter((s) => s.explain);
  const parts = [renderControls()];

  if (ui.view === "compare") {
    const failed = scenarios.some((s) => !s.explain);
    parts.push(failed
      ? errorBlock("Some scenarios could not be explained, so they can’t be compared.", scenarios.find((s) => s.error)?.error)
      : renderCompare());
  } else if (!scenario?.explain) {
    parts.push(errorBlock("Attributions could not be loaded for this scenario.", scenario?.error));
  } else {
    parts.push(
      renderSummary(scenario),
      ui.view === "bar" ? renderBar(scenario) : ui.view === "donut" ? renderDonut(scenario) : renderWaterfall(scenario),
      renderTable(scenario),
      el("p", { class: "fineprint" },
        "Contributions are SHAP values in log-odds, averaged across the model’s ensemble members, so the model output can differ slightly from the ensemble probability."));
  }
  root.setAttribute("aria-busy", "false");
  root.replaceChildren(...parts);
  picker?.setIndex(Math.max(0, VIEWS.findIndex((v) => v.id === ui.view)));
  void ready;
}

function errorBlock(message, error) {
  const status = error?.status;
  const hint = status === 503
    ? "The SHAP explainer didn’t initialize on the server. Check that shap is installed and credit_risk_dataset.csv sits next to main.py."
    : status === 404
      ? "This backend build has no /explain endpoint."
      : "Check that the Credence server is running, then try again.";
  const retry = el("button", { type: "button", class: "btn btn-ghost" }, "Try again");
  retry.addEventListener("click", boot);
  return el("div", { class: "chart-card empty-card" }, el("h3", null, message), el("p", null, hint), retry);
}

/* ---------- graph picker (CircularCarousel) & holo card ---------- */

let picker = null;

// Small illustrations of each chart type, drawn as inline SVG data-URIs.
function thumb(body) {
  const markup = `<svg xmlns="${SVG_NS}" viewBox="0 0 220 220"><rect width="220" height="220" fill="#14111A"/>` +
    `<rect x="0" y="0" width="220" height="220" fill="#2a2038" opacity=".5"/>${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

const THUMBS = {
  bar: () => {
    const rows = [[-62, "#4ADE9B"], [78, "#FF6B8B"], [-34, "#4ADE9B"], [52, "#FF6B8B"], [-18, "#4ADE9B"], [26, "#FF6B8B"]];
    return thumb('<line x1="110" y1="30" x2="110" y2="190" stroke="#4a4058" stroke-width="1.5"/>' +
      rows.map(([w, c], i) => `<rect x="${w < 0 ? 110 + w : 110}" y="${38 + i * 25}" width="${Math.abs(w)}" height="14" rx="3" fill="${c}"/>`).join(""));
  },
  donut: () => {
    const parts = [[0.34, "#FF6B8B"], [0.24, "#ff9db3"], [0.2, "#4ADE9B"], [0.13, "#8ff0c2"], [0.09, "#4a4058"]];
    const r = 54, c = 2 * Math.PI * r;
    let acc = 0;
    return thumb(parts.map(([f, col]) => {
      const seg = `<circle cx="110" cy="110" r="${r}" fill="none" stroke="${col}" stroke-width="30" stroke-dasharray="${(f * c - 2).toFixed(1)} ${(c).toFixed(1)}" stroke-dashoffset="${(-acc * c).toFixed(1)}" transform="rotate(-90 110 110)"/>`;
      acc += f; return seg;
    }).join(""));
  },
  waterfall: () => {
    const steps = [[40, 62, "#F4F1FA"], [62, 88, "#FF6B8B"], [88, 74, "#4ADE9B"], [74, 112, "#FF6B8B"], [112, 96, "#4ADE9B"], [96, 96, "#F4F1FA", true]];
    return thumb('<line x1="26" y1="170" x2="194" y2="170" stroke="#4a4058" stroke-width="1.5"/>' + steps.map(([a, b, c, total], i) => {
      const top = total ? 170 - 96 : 170 - Math.max(a, b), h = total ? 96 : Math.abs(b - a);
      return `<rect x="${30 + i * 28}" y="${top}" width="20" height="${Math.max(h, 4)}" rx="2.5" fill="${c}"/>`;
    }).join(""));
  },
  compare: () => {
    const groups = [[48, -30, 20], [-40, 36, -14], [30, 14, -34], [-22, -10, 44]];
    return thumb('<line x1="110" y1="30" x2="110" y2="190" stroke="#4a4058" stroke-width="1.5"/>' + groups.map((g, i) =>
      g.map((w, j) => `<rect x="${w < 0 ? 110 + w : 110}" y="${36 + i * 38 + j * 10}" width="${Math.abs(w)}" height="8" rx="2" fill="${SCENARIO_COLORS[j]}"/>`).join("")).join(""));
  },
};

const PICKER_ITEMS = [
  { id: "bar", title: "Bar chart", subtitle: "Ranked drivers", alt: "Diverging bars pulling risk up and down around a centre line" },
  { id: "donut", title: "Donut", subtitle: "Share of influence", alt: "Donut chart splitting total influence between features" },
  { id: "waterfall", title: "Waterfall", subtitle: "Step by step", alt: "Waterfall of contributions stepping from base value to model output" },
  { id: "compare", title: "Compare", subtitle: "Across scenarios", alt: "Grouped bars comparing scenarios side by side" },
].map((item) => ({ ...item, src: THUMBS[item.id]() }));

function mountPicker() {
  const section = document.getElementById("graphPicker");
  const stage = document.getElementById("pickerStage");
  if (!section || !stage || !window.CredenceUI) return;
  section.hidden = false;
  picker = window.CredenceUI.circularCarousel(stage, {
    items: PICKER_ITEMS, preset: "cylinder", intro: "rise", cardWidth: 220, aspectRatio: 1, speed: 14, captions: true,
    label: "Graph type", selected: Math.max(0, VIEWS.findIndex((v) => v.id === ui.view)),
    onSelect: (item) => { ui.view = item.id; history.replaceState(null, "", `#${item.id}`); draw(); },
  });
}

document.addEventListener("DOMContentLoaded", () => {
  window.CredenceUI?.holoCard(document.getElementById("holoSlot"), {
    image: "logo-mark.png", alt: "Credence", preset: "bursts",
  });
});

/* ---------- boot ---------- */

async function boot() {
  root = document.getElementById("attrApp");
  root.setAttribute("aria-busy", "true");

  const fromHash = location.hash.slice(1);
  if (VIEWS.some((v) => v.id === fromHash)) ui.view = fromHash;

  scenarios = loadHandoff();
  if (!scenarios.length) {
    root.replaceChildren(el("div", { class: "chart-card empty-card" },
      el("h3", null, "No assessment to explain yet"),
      el("p", null, "Run a risk assessment on the main page first. When you open this page from there, the same applicant is explained here in full."),
      el("a", { class: "btn btn-primary", href: "/#assessment" }, "Go to the assessment")));
    root.setAttribute("aria-busy", "false");
    return;
  }

  root.replaceChildren(el("p", { class: "attr-status" }, `Computing SHAP attributions for ${scenarios.length} scenario${scenarios.length > 1 ? "s" : ""}…`));
  await Promise.all(scenarios.map(async (scenario) => {
    try { scenario.explain = await fetchExplanation(scenario.payload); scenario.error = null; }
    catch (error) { scenario.explain = null; scenario.error = error; console.error("[Credence] /explain failed:", error); }
  }));
  ui.scenario = Math.min(ui.scenario, scenarios.length - 1);
  mountPicker();
  draw();
}

boot();