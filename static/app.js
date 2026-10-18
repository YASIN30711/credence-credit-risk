"use strict";

/* ============================================================
   Credence — credit risk assessment frontend
   Talks to the real FastAPI inference service (POST /predict).
   Every rendered value comes from the live API response.
   ============================================================ */

/* ---------- 1 · Configuration ---------- */

// Empty base = same origin (this UI is served by the FastAPI process).
const API_BASE = "";

const ENDPOINTS = {
  predict: `${API_BASE}/predict`,
  explain: `${API_BASE}/explain`,   // ← SHAP addition
  health: `${API_BASE}/health`,
};

const REQUEST_TIMEOUT_MS = 30000;
const HEALTH_TIMEOUT_MS = 6000;
const MIN_ANALYZING_MS = 850;

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- 1b · Currency support ----------
   The model was trained on USD-scale amounts. Money entered in any
   currency is converted to USD before scoring, so the model keeps
   receiving values within its training distribution. Rates come from
   a free live endpoint; bundled values are an offline fallback. */

const CURRENCIES = [
  { code: "USD", symbol: "$",   label: "US Dollar",          rate: 1 },
  { code: "INR", symbol: "₹",   label: "Indian Rupee",       rate: 84 },
  { code: "EUR", symbol: "€",   label: "Euro",               rate: 0.92 },
  { code: "GBP", symbol: "£",   label: "British Pound",      rate: 0.79 },
  { code: "AED", symbol: "AED", label: "UAE Dirham",         rate: 3.67 },
  { code: "CAD", symbol: "C$",  label: "Canadian Dollar",    rate: 1.37 },
  { code: "AUD", symbol: "A$",  label: "Australian Dollar",  rate: 1.53 },
];

const currency = { code: "USD" };
const getCurrency = () => CURRENCIES.find((c) => c.code === currency.code) ?? CURRENCIES[0];
const toUsd = (amount) => amount / getCurrency().rate;
const fromUsd = (amount) => amount * getCurrency().rate;

const RATES_ENDPOINT = "https://open.er-api.com/v6/latest/USD";

async function loadExchangeRates() {
  const note = document.getElementById("rateNote");
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(RATES_ENDPOINT, { signal: controller.signal });
    clearTimeout(timer);
    const body = await response.json();
    if (response.ok && body && body.rates) {
      CURRENCIES.forEach((c) => {
        if (typeof body.rates[c.code] === "number" && body.rates[c.code] > 0) c.rate = body.rates[c.code];
      });
      if (note) note.textContent = "live rates";
      updateMoneyAffixes(); // refresh placeholders with the live rate
    }
  } catch {
    if (note) note.textContent = "offline · approximate rates";
  }
}

function updateMoneyAffixes() {
  const c = getCurrency();
  FIELDS.filter((f) => f.money).forEach((field) => {
    const affix = document.querySelector(`[data-money-field="${field.name}"]`);
    if (affix) affix.textContent = c.symbol;
    const input = form.elements[field.name];
    if (input) input.placeholder = String(Math.round(field.placeholderUsd * c.rate));
  });
}

function renderCurrencyBar() {
  const select = el("select", { class: "currency-select", id: "currencySelect", name: "currency" });
  CURRENCIES.forEach((c) => {
    select.append(el("option", { value: c.code, selected: c.code === "USD" ? true : null }, `${c.code} · ${c.label}`));
  });
  select.addEventListener("change", () => {
    currency.code = select.value;
    updateMoneyAffixes();
    FIELDS.filter((f) => f.money).forEach((field) => {
      const wrap = form.querySelector(`[data-field="${field.name}"]`);
      if (wrap?.classList.contains("invalid")) {
        const result = validateField(field);
        if (result.valid) clearFieldError(field.name);
        else setFieldError(field.name, result.message);
      }
    });
    showToast(`Amounts will be interpreted in ${getCurrency().label}`);
  });

  document.getElementById("formGroups").before(
    el("div", { class: "currency-bar" },
      el("div", { class: "currency-bar-row" },
        el("span", { class: "currency-bar-label" }, "Amounts entered in"),
        select,
        el("span", { class: "rate-note mono", id: "rateNote" }, "checking rates…")),
      el("p", { class: "currency-bar-note" },
        "Amounts are converted to USD before scoring — the model was trained on USD-scale values. " +
        "The loan-to-income ratio and interest rate are currency-independent.")
    )
  );
}

/* ---------- 2 · Field schema (mirrors the API's LoanApplication) ---------- */

const HOME_OWNERSHIP_OPTIONS = [
  { value: "MORTGAGE", label: "Mortgage" },
  { value: "RENT", label: "Rent" },
  { value: "OWN", label: "Owns outright" },
  { value: "OTHER", label: "Other" },
];

const LOAN_INTENT_OPTIONS = [
  { value: "DEBTCONSOLIDATION", label: "Debt consolidation" },
  { value: "EDUCATION", label: "Education" },
  { value: "HOMEIMPROVEMENT", label: "Home improvement" },
  { value: "MEDICAL", label: "Medical" },
  { value: "PERSONAL", label: "Personal" },
  { value: "VENTURE", label: "Venture / business" },
];

const GRADE_OPTIONS = "ABCDEFG".split("").map((g) => ({ value: g, label: g }));

const FIELD_GROUPS = [
  {
    index: "01",
    title: "Applicant profile",
    caption: "Personal and financial standing of the borrower.",
    fields: [
      { name: "person_age", label: "Age", type: "number", integer: true, min: 18, max: 100, unit: "years", placeholder: "35", helper: "Age of the applicant, in whole years.", span: "short" },
      { name: "person_income", label: "Annual income", type: "number", min: 1, max: 10000000, money: true, placeholderUsd: 62000, placeholder: "62000", helper: "Gross annual income before deductions.", span: "long" },
      { name: "person_home_ownership", label: "Housing status", type: "select", options: HOME_OWNERSHIP_OPTIONS, helper: "Current home-ownership arrangement.", span: "long" },
      { name: "person_emp_length", label: "Employment length", type: "number", min: 0, max: 60, placeholder: "4.5", unit: "years", helper: "Years in current employment.", span: "short" },
    ],
  },
  {
    index: "02",
    title: "Loan request",
    caption: "What is being borrowed, and on what terms.",
    fields: [
      { name: "loan_intent", label: "Purpose", type: "select", options: LOAN_INTENT_OPTIONS, helper: "Stated reason for the loan.", span: "long" },
      { name: "loan_grade", label: "Loan grade", type: "segmented", options: GRADE_OPTIONS, helper: "Credit grade assigned to this loan (A = highest quality).", span: "full" },
      { name: "loan_amnt", label: "Loan amount", type: "number", min: 100, max: 10000000, money: true, placeholderUsd: 12000, placeholder: "12000", helper: "Requested principal.", span: "long" },
      { name: "loan_int_rate", label: "Interest rate", type: "number", min: 0, max: 100, placeholder: "11.49", unit: "%", helper: "Annual rate on the loan (APR).", span: "short" },
      { name: "loan_percent_income", label: "Loan-to-income ratio", type: "number", min: 0, max: 1.5, placeholder: "0.15", helper: "Loan amount ÷ annual income. 0.15 means the loan is 15% of income.", span: "full", extra: "ratio" },
    ],
  },
  {
    index: "03",
    title: "Credit history",
    caption: "What the credit bureau already knows.",
    fields: [
      { name: "cb_person_default_on_file", label: "Default on record", type: "segmented", options: [
        { value: "N", label: "N · clean record" },
        { value: "Y", label: "Y · default on file" },
      ], helper: "Whether the bureau holds a historical default for this applicant.", span: "full" },
      { name: "cb_person_cred_hist_length", label: "Credit history length", type: "number", integer: true, min: 0, max: 80, unit: "years", placeholder: "8", helper: "Years of recorded credit history.", span: "short" },
    ],
  },
];

const FIELDS = FIELD_GROUPS.flatMap((group) => group.fields);
const FIELD_BY_NAME = Object.fromEntries(FIELDS.map((f) => [f.name, f]));

const ANALYZING_STEPS = [
  "validating application against the request schema",
  "handing 11 raw features to the model pipeline",
  "computing probability of default",
  "comparing score against the decision threshold",
];

/* ---------- 3 · Small utilities ---------- */

const ICONS = {
  warn: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 1.8 15 14H1L8 1.8Z" stroke-linejoin="round"/><path d="M8 6v4"/><path d="M8 11.9h.01" stroke-linecap="round"/></svg>',
  copy: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="6" y="6" width="8.5" height="8.5" rx="1.6"/><path d="M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5"/></svg>',
  refresh: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.7-3.95"/><path d="M13.5 1.8v3h-3" stroke-linejoin="round"/></svg>',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const fmtPct = (n, decimals = 1) => `${(n * 100).toFixed(decimals)}%`;
const fmtSigned = (n, decimals = 4) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(decimals)}`;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (value === true) { node.setAttribute(key, ""); continue; }
      if (key === "class") node.className = value;
      else node.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

function svgEl(tag, attrs) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function formatClock(date) {
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return `${time} · ${day}`;
}

/* ---------- 4 · Application state ---------- */

const state = {
  phase: "idle",
  lastPayload: null,
  lastDisplay: null,
  lastResponse: null,
  assessedAt: null,
  compareMode: "off", // "off" | "editing-b" | "showing"
  scenarios: [], // Scenario A baseline plus up to four alternatives (five total)
  editingScenarioIndex: 1,
  comparisonRunId: 0,
  explanationRequestId: 0,
};

let stepTimer = null;
let toastTimer = null;

/* ---------- 5 · DOM references ---------- */

const form = document.getElementById("assessmentForm");
const resultRegion = document.getElementById("resultRegion");
const resultAnnouncer = document.getElementById("resultAnnouncer");
const formNotice = document.getElementById("formNotice");
const submitBtn = document.getElementById("submitBtn");
const submitLabel = document.getElementById("submitLabel");
const toast = document.getElementById("toast");
const formNote = document.querySelector(".form-note");
const NORMAL_FORM_NOTE = formNote?.textContent ?? "Sends the application to POST /predict.";

const helperId = (name) => `${name}-helper`;
const errorId = (name) => `${name}-error`;

/* ---------- 6 · Form construction (schema-driven) ---------- */

function buildForm() {
  const root = document.getElementById("formGroups");
  const banner = el("div", { class: "scenario-mode-banner", id: "scenarioModeBanner", hidden: true },
    el("div", { class: "scenario-mode-copy" },
      el("p", { class: "scenario-mode-eyebrow" }, "Scenario comparison · up to five"),
      el("p", { class: "scenario-mode-text", id: "scenarioModeText" },
        "Scenario B starts as a copy of Scenario A. Change one or more fields, then run the comparison.")
    ),
    el("button", { class: "btn btn-ghost scenario-cancel", type: "button" }, "Cancel comparison")
  );
  banner.querySelector(".scenario-cancel").addEventListener("click", cancelScenarioComparison);
  root.before(banner);

  FIELD_GROUPS.forEach((group) => {
    root.append(
      el("fieldset", { class: "field-group" },
        el("legend", { class: "field-group-legend" },
          el("div", { class: "fg-inner" },
            el("span", { class: "fg-index" }, group.index),
            el("div", null,
              el("span", { class: "fg-title" }, group.title),
              el("span", { class: "fg-caption" }, group.caption)
            )
          )
        ),
        el("div", { class: "field-grid" }, ...group.fields.map(buildField))
      )
    );
  });
}

function buildField(field) {
  const wrap = el("div", { class: `field field-${field.type} span-${field.span}`, "data-field": field.name });
  const labelId = `${field.name}-label`;

  if (field.type === "segmented") {
    const group = el("div", {
      class: "segmented", role: "radiogroup", "aria-labelledby": labelId,
      "aria-describedby": `${helperId(field.name)} ${errorId(field.name)}`,
    });
    field.options.forEach((option) => {
      const inputId = `${field.name}-${option.value}`;
      group.append(el("label", { class: "chip", for: inputId },
        el("input", { type: "radio", name: field.name, value: option.value, id: inputId }),
        el("span", { class: "chip-label" }, option.label)
      ));
    });
    wrap.append(el("span", { class: "field-label", id: labelId }, field.label), group);

  } else if (field.type === "select") {
    const select = el("select", {
      class: "field-select", id: field.name, name: field.name,
      "aria-describedby": `${helperId(field.name)} ${errorId(field.name)}`,
    });
    select.append(el("option", { value: "", disabled: true, selected: true }, "Select an option"));
    field.options.forEach((option) => {
      select.append(el("option", { value: option.value }, option.label));
    });
    wrap.append(
      el("label", { class: "field-label", for: field.name, id: labelId }, field.label),
      el("div", { class: "field-select-wrap" }, select)
    );

  } else {
    const inputWrap = el("div", { class: "field-input-wrap" });
    if (field.money) inputWrap.append(el("span", { class: "field-affix field-affix-money", "data-money-field": field.name }, "$"));
    inputWrap.append(el("input", {
      type: "number", id: field.name, name: field.name,
      readonly: field.extra === "ratio" ? true : null,
      min: field.money ? null : field.min,
      max: field.money ? null : field.max,
      step: field.integer ? "1" : "any",
      inputmode: field.integer ? "numeric" : "decimal",
      placeholder: field.placeholder || "",
      "aria-describedby": `${helperId(field.name)} ${errorId(field.name)}`,
    }));
    if (field.unit) inputWrap.append(el("span", { class: "field-affix field-affix-suffix" }, field.unit));
    wrap.append(
      el("label", { class: "field-label", for: field.name, id: labelId }, field.label),
      inputWrap
    );
  }

  wrap.append(el("p", { class: "field-helper", id: helperId(field.name) }, field.helper));

  if (field.extra === "ratio") {
    wrap.append(
      el("div", { class: "ratio-tools" },
        el("span", { class: "ratio-live mono", id: "ratioLive", "aria-live": "polite" })
      )
    );
  }

  wrap.append(el("p", { class: "field-error", id: errorId(field.name) }));
  return wrap;
}

/* ---------- 7 · Validation ---------- */

function getCheckedValue(name) {
  const checked = form.querySelector(`input[name="${name}"]:checked`);
  return checked ? checked.value : null;
}

function validateField(field) {
  if (field.type === "segmented") {
    return getCheckedValue(field.name)
      ? { valid: true }
      : { valid: false, message: "Select an option." };
  }

  const raw = String(form.elements[field.name]?.value ?? "").trim();
  if (raw === "") return { valid: false, message: "This field is required." };

  if (field.type === "select") {
    return field.options.some((o) => o.value === raw)
      ? { valid: true }
      : { valid: false, message: "Select an option." };
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) return { valid: false, message: "Enter a number." };
  if (field.integer && !Number.isInteger(value)) return { valid: false, message: "Enter a whole number." };

  if (field.money) {
    // Bounds are defined in USD: compare the converted value,
    // but surface the bound in the selected currency.
    const c = getCurrency();
    const usd = toUsd(value);
    const local = (n) => `${c.symbol}${Math.round(fromUsd(n)).toLocaleString("en-US")}`;
    if (usd < field.min) return { valid: false, message: `Must be at least ${local(field.min)}.` };
    if (usd > field.max) return { valid: false, message: `Must be at most ${local(field.max)}.` };
    return { valid: true };
  }

  const bound = (n) => `${field.prefix ?? ""}${n.toLocaleString("en-US")}${field.unit ? ` ${field.unit}` : ""}`;
  if (value < field.min) return { valid: false, message: `Must be at least ${bound(field.min)}.` };
  if (value > field.max) return { valid: false, message: `Must be at most ${bound(field.max)}.` };
  return { valid: true };
}

function setFieldError(name, message) {
  const wrap = form.querySelector(`[data-field="${name}"]`);
  if (!wrap) return;
  wrap.classList.add("invalid");
  const error = document.getElementById(errorId(name));
  if (error) error.innerHTML = `${ICONS.warn}<span>${escapeHtml(message)}</span>`;

  const control = form.elements[name];
  if (control && typeof control.length === "number") {
    for (const input of control) input.setAttribute("aria-invalid", "true");
  } else if (control) {
    control.setAttribute("aria-invalid", "true");
  }
}

function clearFieldError(name) {
  const wrap = form.querySelector(`[data-field="${name}"]`);
  if (wrap) wrap.classList.remove("invalid");
  const error = document.getElementById(errorId(name));
  if (error) error.textContent = "";

  const control = form.elements[name];
  if (control && typeof control.length === "number") {
    for (const input of control) input.removeAttribute("aria-invalid");
  } else if (control) {
    control.removeAttribute("aria-invalid");
  }
}

function validateAll() {
  let firstInvalid = null;
  let count = 0;
  for (const field of FIELDS) {
    const result = validateField(field);
    if (result.valid) {
      clearFieldError(field.name);
    } else {
      setFieldError(field.name, result.message);
      count += 1;
      if (!firstInvalid) firstInvalid = field.name;
    }
  }
  return { valid: count === 0, count, firstInvalid };
}

function collectPayload() {
  const payload = {};
  for (const field of FIELDS) {
    if (field.type === "number") {
      const value = Number(form.elements[field.name].value);
      // Money fields are sent to the API in USD, matching the model's
      // training distribution; everything else goes through unchanged.
      payload[field.name] = field.money ? Math.round(toUsd(value) * 100) / 100 : value;
    } else if (field.type === "select") {
      payload[field.name] = form.elements[field.name].value;
    } else {
      payload[field.name] = getCheckedValue(field.name);
    }
  }
  return payload;
}

function collectDisplayValues() {
  // What the user actually typed, for the recap and the copied snapshot.
  const values = {};
  FIELDS.filter((f) => f.money).forEach((field) => {
    values[field.name] = Number(form.elements[field.name].value);
  });
  return { currency: currency.code, values };
}

function focusControl(name) {
  const control = form.querySelector(`[name="${name}"]`);
  if (control) control.focus();
}

function showFormNotice(count, prefix) {
  formNotice.textContent = prefix
    ? `${prefix} — see the highlighted fields in the form.`
    : `Review the ${count} highlighted field${count > 1 ? "s" : ""} before running the assessment.`;
  formNotice.hidden = false;
}
function hideFormNotice() { formNotice.hidden = true; }

/* ---------- 8 · Ratio helper ---------- */

function updateRatioLive() {
  const live = document.getElementById("ratioLive");
  const ratioInput = form.elements["loan_percent_income"];
  if (!live || !ratioInput) return;

  const income = Number(form.elements["person_income"]?.value);
  const loan = Number(form.elements["loan_amnt"]?.value);

  // Both amounts are in the same selected currency, so the ratio
  // is the same in any currency.
  if (income > 0 && loan > 0) {
    const ratio = loan / income;
    ratioInput.value = Math.round(ratio * 10000) / 10000;
    clearFieldError("loan_percent_income");
    live.textContent = `= ${(ratio * 100).toFixed(1)}% of annual income`;
  } else {
    ratioInput.value = "";
    live.textContent = "";
  }
}

/* ---------- 9 · API layer ---------- */

class ApiError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.detail = detail;
  }
}

function isWellFormedPrediction(data) {
  return (
    data && typeof data === "object" &&
    typeof data.default_probability === "number" && Number.isFinite(data.default_probability) &&
    typeof data.threshold === "number" && Number.isFinite(data.threshold) &&
    typeof data.default_prediction === "number" &&
    (data.default_prediction === 0 || data.default_prediction === 1) &&
    typeof data.Result === "string" && data.Result.length > 0
  );
}

async function requestPrediction(payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  let bodyText;
  try {
    response = await fetch(ENDPOINTS.predict, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    bodyText = await response.text();
  } catch (networkError) {
    if (controller.signal.aborted) throw new ApiError("timeout", "Request timed out");
    throw new ApiError("network", "Network request failed", networkError);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    let parsed = null;
    try { parsed = JSON.parse(bodyText); } catch { /* non-JSON error body */ }
    if (response.status === 422) {
      throw new ApiError("validation", "Request rejected by validation", parsed?.detail ?? parsed);
    }
    if (response.status >= 500) {
      throw new ApiError("server", "Server error", { status: response.status, body: parsed ?? bodyText });
    }
    throw new ApiError("http", "Unexpected status", { status: response.status, body: parsed ?? bodyText });
  }

  let data;
  try { data = JSON.parse(bodyText); } catch {
    throw new ApiError("shape", "Malformed JSON", bodyText);
  }
  if (!isWellFormedPrediction(data)) {
    throw new ApiError("shape", "Unexpected response shape", data);
  }
  return data;
}

/* ---------- 10 · Service status ---------- */

async function checkServiceStatus() {
  const chip = document.getElementById("statusChip");
  const text = document.getElementById("statusText");
  const setState = (value, label) => { chip.dataset.state = value; text.textContent = label; };

  setState("checking", "Checking service…");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINTS.health, { signal: controller.signal });
    if (response.ok) {
      const body = await response.json().catch(() => null);
      setState("online", body?.model_loaded === false ? "Model loading" : "Service online");
    } else if (response.status === 404 || response.status === 405) {
      setState("warn", "API reachable");
    } else {
      setState("warn", `Service responded ${response.status}`);
    }
  } catch (error) {
    setState("offline", "Service unreachable");
    console.error("[Credence] Health check failed:", error);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 11 · State views ---------- */

function renderEmptyState() {
  resultRegion.setAttribute("aria-busy", "false");
  resultAnnouncer.textContent = "";
  resultRegion.replaceChildren(
    el("div", { class: "empty-state" },
      el("p", { class: "empty-title" }, "No assessment yet"),
      el("p", { class: "empty-body" },
        "Complete the form above and run the model — the probability of default, the classification, and the decision context will appear here, exactly as the API returns them.")
    )
  );
}

function clearStepTimer() {
  if (stepTimer) { clearInterval(stepTimer); stepTimer = null; }
}

function appendLogLine(log, text, done = false) {
  const line = el("div", { class: `log-line${done ? " is-done is-on" : ""}` },
    el("span", { class: "log-caret" }, done ? "✓" : "›"),
    el("span", null, text)
  );
  log.append(line);
  return line;
}

function renderAnalyzing() {
  clearStepTimer();
  resultRegion.setAttribute("aria-busy", "true");
  resultAnnouncer.textContent = "Analyzing the application.";

  const log = el("div", { class: "analyzing-log" });
  const lines = ANALYZING_STEPS.map((step) => appendLogLine(log, step));
  let index = 0;
  stepTimer = window.setInterval(() => {
    if (index < lines.length) lines[index++].classList.add("is-on");
    else clearStepTimer();
  }, 480);

  resultRegion.replaceChildren(
    el("div", { class: "analyzing" },
      el("div", { class: "analyzing-head" },
        el("h3", { class: "analyzing-title" }, state.compareMode === "editing-b" ? `Scoring ${scenarioLabel(Number.isInteger(state.editingScenarioIndex) ? state.editingScenarioIndex : state.scenarios.length)}` : "Analyzing application"),
        el("p", { class: "analyzing-sub" }, state.compareMode === "editing-b" ? "POST /predict · compare against baseline Scenario A" : "POST /predict · one request, one response")
      ),
      el("div", { class: "analyzing-bar" }),
      log
    )
  );

  resultRegion.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" });
}

function finishAnalyzing(callback) {
  clearStepTimer();
  const log = resultRegion.querySelector(".analyzing-log");
  if (log) appendLogLine(log, "assessment complete", true);
  window.setTimeout(callback, prefersReducedMotion ? 0 : 320);
}

const ERROR_COPY = {
  network: {
    title: "Can’t reach the inference service",
    body: "The request to POST /predict failed before a response arrived. Make sure the FastAPI service is running — uvicorn main:app — then try again.",
  },
  timeout: {
    title: "The service didn’t respond in time",
    body: `The request was cancelled after ${REQUEST_TIMEOUT_MS / 1000} seconds. If the service was waking from a cold start it may be ready now — try again.`,
  },
  validation: {
    title: "The API rejected the application data",
    body: "The service returned validation errors for the fields highlighted in the form below.",
  },
  server: {
    title: "The inference service reported an error",
    body: "The service responded with a server error while scoring this application. Technical details are in the browser console.",
  },
  shape: {
    title: "Unexpected response format",
    body: "The service answered, but the prediction payload didn’t match the expected contract. The raw response is logged in the browser console.",
  },
  http: {
    title: "The service returned an unexpected status",
    body: "The request completed, but with a status code the interface doesn’t recognise. Details are in the browser console.",
  },
};

function renderErrorPanel(error) {
  resultRegion.setAttribute("aria-busy", "false");
  resultAnnouncer.textContent = "The assessment could not be completed.";

  const copy = ERROR_COPY[error.kind] ?? ERROR_COPY.http;
  const title = el("h3", { class: "error-title", tabindex: "-1" });
  title.innerHTML = `${ICONS.warn}<span>${escapeHtml(copy.title)}</span>`;

  const retryBtn = el("button", { class: "btn btn-primary", type: "button" });
  retryBtn.innerHTML = `${ICONS.refresh}<span>Try again</span>`;
  retryBtn.addEventListener("click", () => {
    if (state.phase === "requesting" || !state.lastPayload) return;
    if (state.compareMode === "editing-b") runScenarioComparison(state.lastPayload, state.lastDisplay);
    else runAssessment(state.lastPayload);
  });

  const reviewBtn = el("button", { class: "btn btn-ghost", type: "button" }, "Review the form");
  reviewBtn.addEventListener("click", () => {
    document.getElementById("assessment").scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth" });
    focusControl(FIELDS[0].name);
  });

  resultRegion.replaceChildren(
    el("div", { class: "error-panel" },
      title,
      el("p", { class: "error-body" }, copy.body),
      el("div", { class: "error-actions" }, retryBtn, reviewBtn)
    )
  );
  title.focus({ preventScroll: true });
}

function applyServerFieldErrors(detail) {
  let applied = 0;
  if (Array.isArray(detail)) {
    detail.forEach((item) => {
      const name = Array.isArray(item.loc) ? item.loc[1] : null;
      if (name && FIELD_BY_NAME[name] && item.msg) {
        setFieldError(name, item.msg);
        applied += 1;
      }
    });
  }
  if (applied > 0) showFormNotice(applied, "The API flagged fields in the form");
}

/* ---------- 12 · Result view ---------- */

function buildNarrative(data) {
  const margin = data.default_probability - data.threshold;
  const direction = margin >= 0 ? "exceeds" : "falls below";
  const classification = data.Result.toLowerCase();
  return `The model estimates a ${fmtPct(data.default_probability)} probability of default, which ${direction} ` +
    `the decision threshold of ${fmtPct(data.threshold)} by ${fmtPct(Math.abs(margin))}. ` +
    `The application is therefore classified as ${classification}. This is a statistical estimate to ` +
    `support a credit decision — not an approval or rejection.`;
}

function factRow(term, value, note, valueClass) {
  const dd = el("dd", { class: valueClass ?? "" }, value,
    note ? el("span", { class: "fact-note" }, note) : null);
  return el("div", { class: "fact" }, el("dt", null, term), dd);
}

function formatFieldValue(field, value) {
  if (value === null || value === undefined) return "—";
  switch (field.name) {
    case "person_income":
    case "loan_amnt": {
      // Rendered in the currency the user entered, with the USD equivalent.
      const c = CURRENCIES.find((x) => x.code === (state.lastDisplay?.currency ?? "USD")) ?? CURRENCIES[0];
      const local = value.toLocaleString("en-US", { maximumFractionDigits: 0 });
      if (c.code === "USD") return `$${local}`;
      const usd = value / c.rate;
      return `${c.symbol}${local} (≈ $${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })})`;
    }
    case "loan_int_rate":
      return `${value}%`;
    case "loan_percent_income":
      return `${value} · ${(value * 100).toFixed(1)}% of income`;
    case "person_age":
    case "person_emp_length":
    case "cb_person_cred_hist_length":
      return `${value} years`;
    case "person_home_ownership":
    case "loan_intent": {
      const option = field.options.find((o) => o.value === value);
      return option ? option.label : String(value);
    }
    case "cb_person_default_on_file":
      return value === "Y" ? "Y · default on file" : "N · clean record";
    case "loan_grade":
      return `Grade ${value}`;
    default:
      return String(value);
  }
}

function buildRecap() {
  const display = state.lastDisplay;
  const valueFor = (field) => (field.money ? display?.values?.[field.name] : state.lastPayload?.[field.name]);
  return el("section", { class: "result-recap" },
    el("h3", { class: "recap-title" }, "Assessed application"),
    el("p", { class: "recap-sub" }, "As entered — money is converted to USD before scoring."),
    el("dl", { class: "recap-grid" },
      ...FIELDS.map((field) => el("div", { class: "recap-item" },
        el("dt", null, field.label),
        el("dd", null, formatFieldValue(field, valueFor(field)))
      ))
    )
  );
}

function buildGauge(container, data, isHighRisk) {
  const W = 720, H = 168;
  const padL = 44, padR = 44;
  const x = (v) => padL + v * (W - padL - padR);
  const y = 104;
  const bandTop = 70, bandH = 22;
  const threshold = clamp01(data.threshold);

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`, class: "gauge", role: "img",
    "aria-label": `Probability of default ${fmtPct(data.default_probability)} on a 0 to 1 scale, ` +
      `against a decision threshold of ${data.threshold.toFixed(3)}.`,
  });

  svg.append(svgEl("rect", { x: x(0), y: bandTop, width: x(threshold) - x(0), height: bandH, class: "gauge-zone-low" }));
  svg.append(svgEl("rect", { x: x(threshold), y: bandTop, width: x(1) - x(threshold), height: bandH, class: "gauge-zone-high" }));

  const zoneLabel = (center, width, text) => {
    if (width < 120) return;
    svg.append(svgEl("text", {
      x: center, y: bandTop + bandH - 7, "text-anchor": "middle", class: "gauge-zone-label",
    }, text));
  };
  zoneLabel((x(0) + x(threshold)) / 2, x(threshold) - x(0), "LOW-RISK SIDE");
  zoneLabel((x(threshold) + x(1)) / 2, x(1) - x(threshold), "HIGH-RISK SIDE");

  svg.append(svgEl("line", { x1: x(0), y1: y, x2: x(1), y2: y, class: "gauge-axis" }));
  for (let i = 0; i <= 20; i += 1) {
    const v = i / 20;
    const major = i % 5 === 0;
    svg.append(svgEl("line", {
      x1: x(v), y1: y, x2: x(v), y2: y - (major ? 14 : 8),
      class: major ? "gauge-tick gauge-tick-major" : "gauge-tick",
    }));
    if (major) {
      const label = v === 0 ? "0" : v === 1 ? "1" : v.toFixed(2);
      svg.append(svgEl("text", {
        x: x(v), y: y + 24, "text-anchor": "middle", class: "gauge-tick-label",
      }, label));
    }
  }

  const thrX = x(threshold);
  let anchor = "middle";
  let labelX = thrX;
  if (thrX < padL + 46) { anchor = "start"; labelX = x(0); }
  else if (thrX > W - padR - 46) { anchor = "end"; labelX = x(1); }
  svg.append(svgEl("line", { x1: thrX, y1: 58, x2: thrX, y2: y + 6, class: "gauge-threshold-line" }));
  const thrLabel = svgEl("text", { x: labelX, y: 34, "text-anchor": anchor, class: "gauge-threshold-label" });
  thrLabel.append(
    svgEl("tspan", { x: labelX, dy: 0 }, "THRESHOLD"),
    svgEl("tspan", { x: labelX, dy: 16, class: "gauge-threshold-value" }, data.threshold.toFixed(3))
  );
  svg.append(thrLabel);

  const marker = svgEl("g", { class: `gauge-marker ${isHighRisk ? "is-high" : "is-low"}` });
  marker.append(
    svgEl("line", { x1: 0, y1: 62, x2: 0, y2: y - 12, class: "gauge-marker-stem" }),
    svgEl("circle", { cx: 0, cy: y, r: 7, class: "gauge-marker-dot" }),
    svgEl("circle", { cx: 0, cy: y, r: 12, class: "gauge-marker-halo" })
  );
  marker.style.transform = `translateX(${x(0)}px)`;
  svg.append(marker);

  container.append(
    svg,
    el("div", { class: "gauge-legend" },
      el("span", { class: "lg" }, "model score"),
      el("span", { class: "lg lg-threshold" }, "decision threshold"),
      el("span", { class: "lg lg-zone" }, "risk zones")
    )
  );

  requestAnimationFrame(() => requestAnimationFrame(() => {
    marker.style.transform = `translateX(${x(clamp01(data.default_probability))}px)`;
  }));
}

function animateNumber(node, target) {
  const targetPct = target * 100;
  if (prefersReducedMotion) { node.textContent = targetPct.toFixed(1); return; }
  const duration = 1000;
  const start = performance.now();
  const frame = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    node.textContent = (targetPct * eased).toFixed(1);
    if (progress < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function renderResult(data) {
  const isHighRisk = data.default_prediction === 1;
  const margin = data.default_probability - data.threshold;

  const result = el("article", { class: `result ${isHighRisk ? "high" : "low"}` });

  result.append(
    el("header", { class: "result-header" },
      el("div", null,
        el("p", { class: "eyebrow" }, "Assessment complete"),
        el("h3", { class: "result-title", tabindex: "-1" },
          isHighRisk ? "High-risk application" : "Low-risk application"),
        el("p", { class: "result-meta" },
          `Scored ${formatClock(state.assessedAt)} · POST /predict`)
      ),
      el("span", { class: `badge ${isHighRisk ? "badge-high" : "badge-low"}` },
        el("span", { class: "badge-dot", "aria-hidden": "true" }),
        data.Result)
    )
  );

  const scoreColumn = el("div", { class: "result-score" },
    el("p", { class: "score-label" }, "Probability of default"),
    el("div", { class: "pd-numeral" },
      el("span", { class: "pd-value", id: "pdValue" }, "0.0"),
      el("span", { class: "pd-unit" }, "%")),
    el("p", { class: "pd-raw" },
      `raw score ${data.default_probability.toFixed(4)} · scale 0–1`)
  );

  result.append(el("div", { class: "result-main" },
    scoreColumn,
    el("div", { class: "result-facts" },
      el("dl", { class: "facts" },
        factRow("Model decision", `${data.default_prediction} · ${isHighRisk ? "default expected" : "no default expected"}`),
        factRow("Decision threshold", data.threshold.toFixed(4)),
        factRow("Margin to threshold", fmtSigned(margin), "derived · probability − threshold",
          margin >= 0 ? "is-high" : "is-low")
      ),
      el("p", { class: "result-narrative" }, buildNarrative(data)),
      el("p", { class: "result-scope" },
        "Decision-support output — a statistical estimate, not an approval or rejection.")
    )
  ));

  result.append(buildRecap());

  const adjustBtn = el("button", { class: "btn btn-primary", type: "button" }, "Adjust & re-run");
  adjustBtn.addEventListener("click", () => {
    document.getElementById("assessment").scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth" });
    focusControl(FIELDS[0].name);
  });

  const newBtn = el("button", { class: "btn btn-ghost", type: "button" }, "New application");
  newBtn.addEventListener("click", resetApplication);

  const copyBtn = el("button", { class: "btn btn-ghost", type: "button" });
  copyBtn.innerHTML = `${ICONS.copy}<span>Copy assessment JSON</span>`;
  copyBtn.addEventListener("click", copyAssessment);

  const printBtn = el("button", { class: "btn btn-ghost", type: "button" }, "Print / Save PDF");
  printBtn.addEventListener("click", () => window.print());

  const actions = [adjustBtn, newBtn, copyBtn, printBtn];
  if (state.compareMode === "off") {
    const compareBtn = el("button", { class: "btn btn-ghost", type: "button" }, "Compare with another scenario");
    compareBtn.addEventListener("click", beginScenarioComparison);
    actions.push(compareBtn);
  }
  result.append(el("div", { class: "result-actions" }, ...actions));

  resultRegion.setAttribute("aria-busy", "false");
  resultRegion.replaceChildren(result);
  [...result.children].forEach((child, i) => child.style.setProperty("--i", i));

  buildGauge(scoreColumn, data, isHighRisk);
  animateNumber(document.getElementById("pdValue"), data.default_probability);

  resultAnnouncer.textContent =
    `Assessment complete: ${data.Result}. Probability of default ${fmtPct(data.default_probability)}.`;

  result.querySelector(".result-title").focus({ preventScroll: true });
}

/* ---------- 13 · Explainability ---------- */

function renderExplainability(data) {
  const box = document.getElementById("xDecision");
  if (!box) return;

  if (!data) {
    box.replaceChildren(el("p", { class: "x-empty" },
      "Run an assessment first — the live distance between the model’s score and the decision " +
      "threshold will appear here, derived from the actual response."));
    return;
  }

  const margin = data.default_probability - data.threshold;
  const classification = data.Result.toLowerCase();
  const sentence = `The model’s probability of default sits ${fmtPct(Math.abs(margin))} ` +
    `${margin >= 0 ? "above" : "below"} the tuned decision threshold, so the application is ` +
    `classified as ${classification}.`;

  box.replaceChildren(
    el("div", { class: `x-margin ${margin >= 0 ? "x-margin-high" : "x-margin-low"}` },
      el("span", { class: "x-margin-value" }, fmtSigned(margin)),
      el("span", { class: "x-margin-label" }, "probability − threshold · derived from the response")),
    el("p", { class: "x-sentence" }, sentence),
    el("p", { class: "x-line" },
      `PD ${data.default_probability.toFixed(4)} · threshold ${data.threshold.toFixed(4)} · classification ${data.Result}`)
  );
}

/* ---------- 13b · Feature attribution (live SHAP from /explain) ---------- */

function attributionPanel() {
  return {
    tag: document.querySelector("#explainability .tag-pending"),
    body: document.querySelector("#explainability .xpanel-body"),
    skeleton: document.querySelector("#explainability .x-skeleton"),
  };
}

function setAttributionNote(text) {
  const { body, skeleton } = attributionPanel();
  if (skeleton) skeleton.replaceChildren(el("p", { class: "attr-note" }, text));
  if (body) body.textContent = text;
}

function showAttributionLoading() {
  const { skeleton } = attributionPanel();
  if (skeleton) skeleton.replaceChildren(
    el("p", { class: "attr-note" }, "computing feature attributions…")
  );
}

async function probeExplainEndpoint() {
  // A GET on a POST-only route returns 405 when the route exists,
  // 404 when this backend build has no /explain at all.
  try {
    const response = await fetch(ENDPOINTS.explain, { method: "GET" });
    if (response.status !== 405 && response.status !== 422) return;
    const { tag, body } = attributionPanel();
    if (tag) {
      tag.textContent = "Live · per assessment";
      tag.classList.remove("tag-pending");
      tag.classList.add("tag-live");
    }
    if (body) body.textContent =
      "Real SHAP attributions are computed for each assessed applicant — features ranked " +
      "by their impact on this prediction, with signed contributions straight from the model.";
  } catch { /* offline — keep the default "awaiting" copy */ }
}

function attributionValueLabel(field, rawValue) {
  if (!field) return String(rawValue);
  if (field.money) {
    const c = getCurrency();
    const local = fromUsd(Number(rawValue));
    return `${c.symbol}${local.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  }
  if (field.options) {
    const option = field.options.find((o) => o.value === rawValue);
    return option ? option.label : String(rawValue);
  }
  if (field.unit === "years") return `${rawValue} yrs`;
  if (field.unit === "%") return `${rawValue}%`;
  return String(rawValue);
}

function renderFeatureAttribution(data) {
  const { tag, skeleton } = attributionPanel();
  if (tag) {
    tag.textContent = "Live · from this prediction";
    tag.classList.remove("tag-pending");
    tag.classList.add("tag-live");
  }
  const items = Array.isArray(data?.shap_values) ? data.shap_values : [];
  if (!items.length || !skeleton) {
    setAttributionNote("No attribution data was returned.");
    return;
  }

  const maxAbs = Math.max(...items.map((item) => Math.abs(item.contribution)), 1e-9);
  const rows = items.map((item) => {
    const field = FIELD_BY_NAME[item.feature];
    const width = Math.max(2, Math.round((Math.abs(item.contribution) / maxAbs) * 100));
    return el("div", { class: `attr-row${item.contribution >= 0 ? " attr-up" : " attr-down"}` },
      el("div", { class: "attr-meta" },
        el("span", { class: "attr-name" }, field?.label ?? item.feature),
        el("span", { class: "attr-value mono" }, attributionValueLabel(field, item.value))),
      el("div", { class: "attr-track" },
        el("span", { class: "attr-bar", style: `width:${width}%` })),
      el("span", { class: "attr-contrib mono" }, fmtSigned(item.contribution, 3))
    );
  });

  const parts = [
    el("div", { class: "attr-legend" },
      el("span", { class: "lg-up" }, "▲ increases risk"),
      el("span", { class: "lg-down" }, "▼ decreases risk")),
    el("div", { class: "attr-rows" }, ...rows),
  ];
  parts.push(el("p", { class: "attr-base mono" },
    "bar length = relative influence on this applicant’s risk score (log-odds units)"));
  skeleton.replaceChildren(...parts);
}

async function fetchExplanation(payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINTS.explain, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    if (!response.ok) {
      let parsed = null;
      try { parsed = JSON.parse(bodyText); } catch { /* non-JSON body */ }
      const error = new Error(parsed?.detail ?? `Status ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return JSON.parse(bodyText);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function loadFeatureAttribution() {
  if (!state.lastPayload) return;
  const requestId = ++state.explanationRequestId;
  const payload = deepCopy(state.lastPayload);
  showAttributionLoading();
  try {
    const explanation = await fetchExplanation(payload);
    if (requestId !== state.explanationRequestId) return;
    renderFeatureAttribution(explanation);
  } catch (error) {
    if (requestId !== state.explanationRequestId) return;
    console.error("[Credence] Explanation request failed:", error);
    const status = error.status;
    const note = status === 503
      ? "Explainability is unavailable on this service — the SHAP explainer didn't initialize. Check that shap is installed and credit_risk_dataset.csv sits next to main.py (details in the console)."
      : status === 404
        ? "This backend build has no /explain endpoint — update main.py to serve attributions."
        : "Attributions could not be loaded — the prediction above is unaffected.";
    setAttributionNote(note);
  }
}

/* ---------- 13c · Multi-scenario comparison (frontend orchestration) ---------- */

const MAX_SCENARIOS = 5;

function deepCopy(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function scenarioLabel(index) {
  return `Scenario ${String.fromCharCode(65 + index)}`;
}

function makeScenarioSnapshot(payload, display, response, assessedAt) {
  return {
    payload: deepCopy(payload),
    display: deepCopy(display),
    response: deepCopy(response),
    assessedAt: assessedAt ? new Date(assessedAt) : new Date(),
  };
}

function getChangedFields(payloadA, payloadB) {
  if (!payloadA || !payloadB) return [];
  return FIELDS.filter((field) => {
    const a = payloadA[field.name];
    const b = payloadB[field.name];
    if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) > 1e-9;
    return a !== b;
  });
}

function updateComparisonModeUI(isEditing, message) {
  const banner = document.getElementById("scenarioModeBanner");
  const bannerText = document.getElementById("scenarioModeText");
  if (banner) banner.hidden = !isEditing;
  if (bannerText && message) bannerText.textContent = message;
  const currencySelect = document.getElementById("currencySelect");
  if (currencySelect) {
    currencySelect.disabled = isEditing || state.compareMode === "showing";
    currencySelect.title = currencySelect.disabled
      ? "Currency is locked during a comparison so all scenarios use the same display currency."
      : "Choose the currency for entered money values.";
  }
  if (formNote) {
    formNote.textContent = isEditing
      ? "Each scenario is scored by the same live model. Scenario A stays as the baseline; change the inputs you want to test."
      : NORMAL_FORM_NOTE;
  }
  setSubmitLoading(false);
}

function beginScenarioComparison() {
  if (!state.lastPayload || !state.lastResponse) {
    showToast("Run an assessment before comparing scenarios");
    return;
  }
  state.comparisonRunId += 1;
  state.scenarios = [makeScenarioSnapshot(
    state.lastPayload, state.lastDisplay, state.lastResponse, state.assessedAt
  )];
  state.editingScenarioIndex = 1;
  state.compareMode = "editing-b";
  state.phase = "editing-comparison";
  populateFormFromScenario(state.scenarios[0]);
  state.explanationRequestId += 1;
  updateComparisonModeUI(true,
    `Scenario A is saved as the baseline. Create Scenario B (${state.scenarios.length + 1} of ${MAX_SCENARIOS}) by changing one or more inputs.`);
  hideFormNotice();
  document.getElementById("assessment").scrollIntoView({
    behavior: prefersReducedMotion ? "auto" : "smooth", block: "start"
  });
  focusControl(FIELDS[0].name);
}

function populateFormFromScenario(scenario) {
  if (!scenario?.payload) return;
  const desiredCurrency = scenario.display?.currency ?? "USD";
  const currencySelect = document.getElementById("currencySelect");
  if (currencySelect) {
    currencySelect.disabled = false;
    const supported = CURRENCIES.some((item) => item.code === desiredCurrency);
    if (supported) {
      currency.code = desiredCurrency;
      currencySelect.value = desiredCurrency;
    }
  }
  FIELDS.forEach((field) => {
    const value = field.money
      ? (scenario.display?.values?.[field.name] ?? fromUsd(Number(scenario.payload[field.name])))
      : scenario.payload[field.name];
    if (field.type === "segmented") {
      form.querySelectorAll(`input[name="${field.name}"]`).forEach((input) => {
        input.checked = input.value === String(value);
      });
    } else if (form.elements[field.name]) {
      form.elements[field.name].value = String(value ?? "");
    }
    clearFieldError(field.name);
  });
  updateMoneyAffixes();
  updateRatioLive();
  // Keep the exact value that was scored rather than the form's live recalculation.
  if (form.elements["loan_percent_income"]) {
    form.elements["loan_percent_income"].value = String(scenario.payload.loan_percent_income);
  }
}

function cancelScenarioComparison() {
  if (state.scenarios.length > 1) {
    state.comparisonRunId += 1;
    state.compareMode = "showing";
    state.phase = "comparison";
    state.editingScenarioIndex = null;
    updateComparisonModeUI(false);
    hideFormNotice();
    renderScenarioComparison();
    void loadComparisonExplanations(state.scenarios.slice(), state.comparisonRunId);
    document.getElementById("result").scrollIntoView({
      behavior: prefersReducedMotion ? "auto" : "smooth", block: "start"
    });
    return;
  }
  exitScenarioComparison("A");
}

function exitScenarioComparison(which = "last") {
  const selected = which === "A"
    ? state.scenarios[0]
    : (state.scenarios[state.scenarios.length - 1] ?? state.scenarios[0]);
  if (!selected) {
    resetApplication();
    return;
  }
  state.comparisonRunId += 1;
  state.compareMode = "off";
  state.scenarios = [];
  state.editingScenarioIndex = 1;
  state.phase = "result";
  state.lastPayload = deepCopy(selected.payload);
  state.lastDisplay = deepCopy(selected.display);
  state.lastResponse = deepCopy(selected.response);
  state.assessedAt = new Date(selected.assessedAt);
  populateFormFromScenario(selected);
  updateComparisonModeUI(false);
  hideFormNotice();
  renderResult(state.lastResponse);
  renderExplainability(state.lastResponse);
  loadFeatureAttribution();
  setSubmitLoading(false);
  document.getElementById("result").scrollIntoView({
    behavior: prefersReducedMotion ? "auto" : "smooth", block: "start"
  });
}

function editScenario(index) {
  if (index <= 0 || index >= state.scenarios.length) return;
  state.comparisonRunId += 1;
  state.editingScenarioIndex = index;
  state.compareMode = "editing-b";
  state.phase = "editing-comparison";
  populateFormFromScenario(state.scenarios[index]);
  updateComparisonModeUI(true,
    `Editing ${scenarioLabel(index)}. Scenario A remains the baseline. Save your changes to update this scenario.`);
  hideFormNotice();
  document.getElementById("assessment").scrollIntoView({
    behavior: prefersReducedMotion ? "auto" : "smooth", block: "start"
  });
  focusControl(FIELDS[0].name);
}

function addScenario() {
  if (state.scenarios.length >= MAX_SCENARIOS) {
    showToast(`Limit reached: compare up to ${MAX_SCENARIOS} scenarios at once`);
    return;
  }
  state.comparisonRunId += 1;
  state.editingScenarioIndex = state.scenarios.length;
  state.compareMode = "editing-b";
  state.phase = "editing-comparison";
  // Start each new candidate from the fixed baseline so its deltas are easy to interpret.
  populateFormFromScenario(state.scenarios[0]);
  updateComparisonModeUI(true,
    `Creating ${scenarioLabel(state.editingScenarioIndex)} (${state.scenarios.length + 1} of ${MAX_SCENARIOS}). Scenario A remains the baseline; change the inputs you want to test.`);
  hideFormNotice();
  document.getElementById("assessment").scrollIntoView({
    behavior: prefersReducedMotion ? "auto" : "smooth", block: "start"
  });
  focusControl(FIELDS[0].name);
}

function removeScenario(index) {
  if (index <= 0 || index >= state.scenarios.length) return;
  state.comparisonRunId += 1;
  state.scenarios.splice(index, 1);
  state.editingScenarioIndex = null;
  if (state.scenarios.length === 1) {
    exitScenarioComparison("A");
    showToast("Only the baseline remains; comparison has ended");
    return;
  }
  state.compareMode = "showing";
  state.phase = "comparison";
  renderScenarioComparison();
  void loadComparisonExplanations(state.scenarios.slice(), state.comparisonRunId);
}

function formatScenarioFieldValue(scenario, field) {
  if (!scenario || !field) return "—";
  const value = field.money
    ? scenario.display?.values?.[field.name]
    : scenario.payload?.[field.name];
  if (value === null || value === undefined) return "—";
  if (field.money) {
    const selected = CURRENCIES.find((item) => item.code === (scenario.display?.currency ?? "USD")) ?? CURRENCIES[0];
    const local = Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
    const usdAmount = Number(scenario.payload[field.name]);
    return selected.code === "USD"
      ? `$${local}`
      : `${selected.symbol}${local} (≈ $${usdAmount.toLocaleString("en-US", { maximumFractionDigits: 0 })})`;
  }
  switch (field.name) {
    case "loan_int_rate": return `${value}%`;
    case "loan_percent_income": return `${Number(value).toFixed(3)} · ${(Number(value) * 100).toFixed(1)}% of income`;
    case "person_age":
    case "person_emp_length":
    case "cb_person_cred_hist_length": return `${value} years`;
    case "person_home_ownership":
    case "loan_intent": {
      const option = field.options?.find((item) => item.value === value);
      return option?.label ?? String(value);
    }
    case "cb_person_default_on_file": return value === "Y" ? "Y · default on file" : "N · clean record";
    case "loan_grade": return `Grade ${value}`;
    default: return String(value);
  }
}

function comparisonScenarioCard(index, scenario, baseline) {
  const data = scenario.response;
  const isHighRisk = data.default_prediction === 1;
  const margin = data.default_probability - data.threshold;
  const deltaPp = (data.default_probability - baseline.response.default_probability) * 100;
  const hasBaseline = index > 0;
  const header = el("div", { class: "comparison-card-head" },
    el("div", null,
      el("p", { class: "comparison-card-kicker" }, `${scenarioLabel(index)}${index === 0 ? " · baseline" : " · modified"}`),
      el("p", { class: "comparison-card-time" }, `Scored ${formatClock(new Date(scenario.assessedAt))}`)
    ),
    el("span", { class: `badge ${isHighRisk ? "badge-high" : "badge-low"}` },
      el("span", { class: "badge-dot", "aria-hidden": "true" }), data.Result)
  );
  const card = el("article", { class: "comparison-scenario-card" },
    header,
    el("p", { class: "comparison-score-label" }, "Probability of default"),
    el("p", { class: `comparison-score ${isHighRisk ? "is-high" : "is-low"}` }, fmtPct(data.default_probability, 2)),
    el("dl", { class: "comparison-facts" },
      factRow("Decision threshold", data.threshold.toFixed(4)),
      factRow("Margin to threshold", fmtSigned(margin, 4), "probability − threshold",
        margin > 0 ? "is-high" : margin < 0 ? "is-low" : ""),
      factRow("Model output", data.default_prediction === 1 ? "1 · default predicted" : "0 · no default predicted"),
      factRow("Change vs Scenario A", hasBaseline ? `${fmtSigned(deltaPp, 2)} pp` : "Baseline", "probability difference",
        deltaPp > 1e-9 ? "is-high" : deltaPp < -1e-9 ? "is-low" : "")
    )
  );
  if (hasBaseline) {
    const actions = el("div", { class: "scenario-card-actions" });
    const editBtn = el("button", { class: "btn btn-ghost", type: "button" }, `Edit ${scenarioLabel(index)}`);
    editBtn.addEventListener("click", () => editScenario(index));
    const removeBtn = el("button", { class: "btn btn-ghost", type: "button" }, `Remove ${scenarioLabel(index)}`);
    removeBtn.addEventListener("click", () => removeScenario(index));
    actions.append(editBtn, removeBtn);
    card.append(actions);
  }
  return card;
}

function renderScenarioComparison() {
  const scenarios = state.scenarios;
  if (!scenarios.length) return;
  const baseline = scenarios[0];
  const baseProbability = baseline.response.default_probability;
  const probabilityDeltas = scenarios.slice(1).map((scenario, index) => ({
    index: index + 1,
    deltaPp: (scenario.response.default_probability - baseProbability) * 100,
    result: scenario.response.Result,
  }));
  const largestShift = probabilityDeltas.reduce((best, item) =>
    !best || Math.abs(item.deltaPp) > Math.abs(best.deltaPp) ? item : best, null);
  const classificationChanges = probabilityDeltas.filter((item) => item.result !== baseline.response.Result).length;
  const deltaClass = !largestShift || Math.abs(largestShift.deltaPp) < 1e-9
    ? "is-neutral" : largestShift.deltaPp > 0 ? "is-high" : "is-low";

  const changedFields = FIELDS.filter((field) => scenarios.slice(1).some((scenario) =>
    getChangedFields(baseline.payload, scenario.payload).some((changed) => changed.name === field.name)));
  const matrix = el("div", { class: "comparison-matrix-wrap" },
    el("table", { class: "comparison-matrix" },
      el("thead", null, el("tr", null,
        el("th", { scope: "col" }, "Input changed"),
        ...scenarios.map((scenario, index) => el("th", { scope: "col" }, scenarioLabel(index)))
      )),
      el("tbody", null,
        ...changedFields.map((field) => el("tr", null,
          el("th", { scope: "row" }, field.label),
          ...scenarios.map((scenario) => {
            const isChanged = getChangedFields(baseline.payload, scenario.payload).some((item) => item.name === field.name);
            return el("td", { class: isChanged ? "comparison-matrix-changed" : "" }, formatScenarioFieldValue(scenario, field));
          })
        ))
      )
    )
  );

  const addBtn = el("button", {
    class: state.scenarios.length >= MAX_SCENARIOS ? "btn btn-ghost comparison-limit-button" : "btn btn-primary",
    type: "button",
    disabled: state.scenarios.length >= MAX_SCENARIOS,
    title: state.scenarios.length >= MAX_SCENARIOS ? `Maximum of ${MAX_SCENARIOS} scenarios reached` : "Add another scenario"
  }, state.scenarios.length >= MAX_SCENARIOS
    ? `Limit reached (${MAX_SCENARIOS}/${MAX_SCENARIOS})`
    : `Add ${scenarioLabel(state.scenarios.length)} (${state.scenarios.length + 1}/${MAX_SCENARIOS})`);
  addBtn.addEventListener("click", addScenario);
  const finishBtn = el("button", { class: "btn btn-ghost", type: "button" }, "Finish comparison");
  finishBtn.addEventListener("click", () => exitScenarioComparison("last"));
  const actions = el("div", { class: "result-actions comparison-actions" }, addBtn, finishBtn);
  const limitNote = el("p", { class: "comparison-limit-note", role: "status" },
    state.scenarios.length >= MAX_SCENARIOS
      ? `You have reached the hard limit of ${MAX_SCENARIOS} scenarios. Remove one of Scenarios B–E to free a slot.`
      : `${state.scenarios.length} of ${MAX_SCENARIOS} scenario slots used. Scenario A remains the fixed baseline.`);

  const changeSection = el("section", { class: "comparison-changes" },
    el("div", { class: "comparison-subhead" },
      el("h4", null, `Changed inputs (${changedFields.length})`),
      el("p", null, "Values shown for every scenario; highlighted cells differ from baseline A")
    ),
    changedFields.length ? matrix : el("p", { class: "comparison-empty-note" },
      "No inputs differ from the baseline yet.")
  );

  const shapSection = el("section", { class: "comparison-shap" },
    el("div", { class: "comparison-subhead" },
      el("h4", null, "SHAP contribution changes"),
      el("p", null, `Compared against Scenario A using POST /explain for up to ${scenarios.length} scenarios.`)
    ),
    el("div", { class: "comparison-shap-region", id: "comparisonShapRegion", "aria-live": "polite" },
      el("p", { class: "comparison-empty-note" }, "Calculating each scenario's SHAP contribution differences from baseline A…")
    )
  );

  const view = el("section", { class: "scenario-comparison", "aria-labelledby": "comparisonTitle" },
    el("header", { class: "comparison-heading" },
      el("p", { class: "eyebrow" }, "Scenario comparison · maximum five"),
      el("h3", { id: "comparisonTitle" }, "Compare scenarios against one baseline"),
      el("p", { class: "comparison-intro" },
        "Scenario A stays fixed as the baseline. Add up to four alternatives (B–E), each scored by the same live model and threshold. Probability differences are relative to A.")
    ),
    el("div", { class: "comparison-deltas" },
      el("article", { class: "comparison-delta-card" },
        el("p", { class: "comparison-delta-label" }, "Largest probability shift vs A"),
        el("p", { class: `comparison-delta-value ${deltaClass}` }, largestShift ? `${fmtSigned(largestShift.deltaPp, 2)} pp` : "—"),
        el("p", { class: "comparison-delta-note" }, largestShift ? `${scenarioLabel(largestShift.index)} · B−A style percentage-point difference` : "Add a scenario to compare it with A")
      ),
      el("article", { class: "comparison-delta-card" },
        el("p", { class: "comparison-delta-label" }, "Classification changes"),
        el("p", { class: "comparison-delta-value" }, `${classificationChanges} / ${Math.max(0, scenarios.length - 1)}`),
        el("p", { class: "comparison-delta-note" }, "Alternatives that differ from baseline A")
      ),
      el("article", { class: "comparison-delta-card" },
        el("p", { class: "comparison-delta-label" }, "Scenario slots"),
        el("p", { class: "comparison-delta-value" }, `${scenarios.length} / ${MAX_SCENARIOS}`),
        el("p", { class: "comparison-delta-note" }, "Maximum total includes baseline A")
      )
    ),
    el("div", { class: "comparison-scenarios" },
      ...scenarios.map((scenario, index) => comparisonScenarioCard(index, scenario, baseline))
    ),
    limitNote,
    changeSection,
    shapSection,
    el("p", { class: "comparison-disclaimer" },
      "This compares model outputs, not proof that changing an input causes a real-world change in default risk. Use as decision support, not as an automated lending decision."),
    actions
  );

  resultRegion.setAttribute("aria-busy", "false");
  resultRegion.replaceChildren(view);
  resultAnnouncer.textContent = `Comparison complete. ${scenarios.length} scenarios shown; Scenario A is the baseline.`;
  setSubmitLoading(false);
}

async function loadComparisonExplanations(scenarios, runId) {
  const requestId = ++state.explanationRequestId;
  const explanations = await Promise.all(scenarios.map((scenario, index) =>
    fetchExplanation(scenario.payload).catch((error) => {
      console.warn(`[Credence] ${scenarioLabel(index)} SHAP request failed:`, error);
      return null;
    })
  ));
  if (runId !== state.comparisonRunId || state.compareMode !== "showing" ||
      requestId !== state.explanationRequestId) return;
  renderComparisonShap(explanations, scenarios);
  const lastExplanation = explanations.slice(1).reverse().find(Boolean) ?? explanations[0];
  if (lastExplanation) renderFeatureAttribution(lastExplanation);
  else setAttributionNote("SHAP explanations could not be loaded. The model predictions above remain available.");
}

function renderComparisonShap(explanations, scenarios) {
  const region = document.getElementById("comparisonShapRegion");
  if (!region) return;
  const missing = explanations.map((item, index) => item?.shap_values?.length ? null : scenarioLabel(index)).filter(Boolean);
  if (missing.length || !explanations[0]?.shap_values?.length) {
    region.replaceChildren(el("p", { class: "comparison-empty-note" },
      `SHAP comparison is unavailable for ${missing.join(", ") || "Scenario A"}. The prediction comparisons remain available.`));
    return;
  }

  const baseline = explanations[0];
  const baseByFeature = new Map(baseline.shap_values.map((row) => [row.feature, row]));
  const maps = explanations.map((explanation) => new Map(explanation.shap_values.map((row) => [row.feature, row])));
  const ranked = FIELDS.map((field) => {
    const baseContribution = Number(baseByFeature.get(field.name)?.contribution ?? 0);
    const deltas = maps.slice(1).map((featureMap) => Number(featureMap.get(field.name)?.contribution ?? 0) - baseContribution);
    return { field, baseContribution, deltas, maxShift: Math.max(0, ...deltas.map((value) => Math.abs(value))) };
  }).sort((a, b) => b.maxShift - a.maxShift).slice(0, 6);

  const headerCells = [el("th", { scope: "col" }, "Feature"), el("th", { scope: "col" }, "A contribution")];
  scenarios.slice(1).forEach((_, index) => {
    headerCells.push(el("th", { scope: "col" }, `${scenarioLabel(index + 1)} contribution`));
    headerCells.push(el("th", { scope: "col" }, `Δ ${String.fromCharCode(66 + index)} − A`));
  });
  const table = el("table", { class: "comparison-shap-table comparison-shap-multi-table" },
    el("thead", null, el("tr", null, ...headerCells)),
    el("tbody", null,
      ...ranked.map(({ field, baseContribution, deltas }) => {
        const featureValues = scenarios.map((scenario) => formatScenarioFieldValue(scenario, field)).join(" · ");
        const cells = [el("th", { scope: "row" },
          el("span", { class: "comparison-shap-feature" }, field.label),
          el("span", { class: "comparison-shap-values" }, featureValues)
        ), el("td", { class: "mono" }, fmtSigned(baseContribution, 3))];
        deltas.forEach((delta, index) => {
          const contribution = Number(maps[index + 1].get(field.name)?.contribution ?? 0);
          cells.push(el("td", { class: "mono" }, fmtSigned(contribution, 3)));
          cells.push(el("td", { class: `mono ${delta > 1e-9 ? "is-high" : delta < -1e-9 ? "is-low" : "is-neutral"}` }, fmtSigned(delta, 3)));
        });
        return el("tr", null, ...cells);
      })
    )
  );
  region.replaceChildren(
    table,
    el("p", { class: "comparison-shap-note" },
      "Showing the six features with the largest contribution shift across tested scenarios. SHAP values are log-odds contributions; Δ columns are each scenario minus baseline A, not percentage-point changes in default probability.")
  );
}

async function runScenarioComparison(payload, display) {
  if (state.phase === "requesting" || !state.scenarios.length) return;
  const index = Number.isInteger(state.editingScenarioIndex) ? state.editingScenarioIndex : state.scenarios.length;
  if (index < 1 || index >= MAX_SCENARIOS) {
    showToast(`Limit reached: compare up to ${MAX_SCENARIOS} scenarios at once`);
    return;
  }
  const baseline = state.scenarios[0];
  const changed = getChangedFields(baseline.payload, payload);
  if (!changed.length) {
    formNotice.textContent = `Change at least one input so ${scenarioLabel(index)} differs from baseline Scenario A.`;
    formNotice.hidden = false;
    return;
  }
  const duplicateIndex = state.scenarios.findIndex((scenario, candidateIndex) =>
    candidateIndex !== index && getChangedFields(scenario.payload, payload).length === 0);
  if (duplicateIndex >= 0) {
    formNotice.textContent = `${scenarioLabel(index)} matches ${scenarioLabel(duplicateIndex)} exactly. Change an input or edit the existing scenario instead.`;
    formNotice.hidden = false;
    return;
  }

  const runId = ++state.comparisonRunId;
  state.phase = "requesting";
  state.lastPayload = deepCopy(payload);
  state.lastDisplay = deepCopy(display);
  setSubmitLoading(true);
  renderAnalyzing();

  try {
    const [data] = await Promise.all([
      requestPrediction(payload),
      sleep(prefersReducedMotion ? 0 : MIN_ANALYZING_MS),
    ]);
    const snapshot = makeScenarioSnapshot(payload, display, data, new Date());
    if (index < state.scenarios.length) state.scenarios[index] = snapshot;
    else state.scenarios.push(snapshot);
    state.lastPayload = deepCopy(payload);
    state.lastDisplay = deepCopy(display);
    state.lastResponse = deepCopy(data);
    state.assessedAt = new Date(snapshot.assessedAt);
    state.editingScenarioIndex = null;
    state.compareMode = "showing";
    state.phase = "comparison";
    renderScenarioComparison();
    renderExplainability(data);
    setAttributionNote(`Computing SHAP attribution differences for ${state.scenarios.length} scenarios against baseline A…`);
    void loadComparisonExplanations(state.scenarios.slice(), runId);
    document.getElementById("result").scrollIntoView({
      behavior: prefersReducedMotion ? "auto" : "smooth", block: "start"
    });
  } catch (error) {
    clearStepTimer();
    state.phase = "error";
    console.error("[Credence] Scenario prediction failed:", error);
    if (error instanceof ApiError && error.kind === "validation") applyServerFieldErrors(error.detail);
    renderErrorPanel(error);
  } finally {
    setSubmitLoading(false);
  }
}

function editCurrentScenario() {
  if (state.scenarios.length > 1) {
    editScenario(state.scenarios.length - 1);
  } else {
    addScenario();
  }
}

/* ---------- 14 · Copy, reset, toast ---------- */

function copyAssessment() {
  if (!state.lastResponse || !state.lastPayload) return;
  const snapshot = {
    endpoint: "POST /predict",
    request: state.lastPayload,       // amounts already converted to USD
    entered: state.lastDisplay,       // amounts exactly as the user typed them
    response: state.lastResponse,
    assessedAt: state.assessedAt?.toISOString() ?? null,
  };
  const text = JSON.stringify(snapshot, null, 2);
  const done = () => showToast("Assessment JSON copied to clipboard");
  const fail = () => {
    console.info("[Credence] Assessment snapshot:", text);
    showToast("Clipboard unavailable — snapshot logged to the console");
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fail);
  } else {
    fail();
  }
}

function resetApplication() {
  state.comparisonRunId += 1; // invalidate any SHAP requests still in flight
  state.compareMode = "off";
  state.scenarios = [];
  state.editingScenarioIndex = 1;
  form.reset();
  const currencySelect = document.getElementById("currencySelect");
  if (currencySelect) {
    currencySelect.disabled = false;
    currency.code = currencySelect.value; // reset restores USD
  }
  updateComparisonModeUI(false);
  updateMoneyAffixes();
  FIELDS.forEach((field) => clearFieldError(field.name));
  hideFormNotice();
  updateRatioLive();
  state.phase = "idle";
  state.lastPayload = null;
  state.lastDisplay = null;
  state.lastResponse = null;
  state.assessedAt = null;
  setSubmitLoading(false);
  renderEmptyState();
  renderExplainability(null);
  document.getElementById("assessment").scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth" });
  focusControl(FIELDS[0].name);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

/* ---------- 15 · Submission flow ---------- */

function setSubmitLoading(isLoading) {
  // In comparison-result mode this same form button is the shortcut back to
  // editing Scenario B, so it must stay enabled when no request is running.
  submitBtn.disabled = isLoading;
  submitBtn.classList.toggle("is-loading", isLoading);
  submitBtn.setAttribute("aria-busy", String(isLoading));
  if (isLoading) {
    submitLabel.textContent = state.compareMode === "editing-b"
      ? `Scoring ${scenarioLabel(Number.isInteger(state.editingScenarioIndex) ? state.editingScenarioIndex : state.scenarios.length)}…`
      : "Analyzing…";
  } else if (state.compareMode === "editing-b") {
    const index = Number.isInteger(state.editingScenarioIndex) ? state.editingScenarioIndex : state.scenarios.length;
    submitLabel.textContent = index < state.scenarios.length
      ? `Update ${scenarioLabel(index)}`
      : `Run ${scenarioLabel(index)}`;
  } else if (state.compareMode === "showing") {
    submitLabel.textContent = "Edit latest scenario to continue";
  } else {
    submitLabel.textContent = "Run risk assessment";
  }
}

async function runAssessment(payload) {
  state.phase = "requesting";
  state.lastPayload = payload;
  setSubmitLoading(true);
  renderAnalyzing();

  try {
    const [data] = await Promise.all([
      requestPrediction(payload),
      sleep(prefersReducedMotion ? 0 : MIN_ANALYZING_MS),
    ]);
    state.lastResponse = data;
    state.assessedAt = new Date();
    finishAnalyzing(() => {
      state.phase = "result";
      renderResult(data);
      renderExplainability(data);
      loadFeatureAttribution();   // ← SHAP addition
    });
  } catch (error) {
    clearStepTimer();
    state.phase = "error";
    console.error("[Credence] Prediction request failed:", error);
    if (error instanceof ApiError && error.kind === "validation") {
      applyServerFieldErrors(error.detail);
    }
    renderErrorPanel(error);
  } finally {
    setSubmitLoading(false);
  }
}

/* ---------- 16 · Event wiring ---------- */

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.phase === "requesting") return;

  // In comparison-result mode, this shortcut edits the latest candidate
  // rather than submitting stale form values as a new prediction.
  if (state.compareMode === "showing") {
    editCurrentScenario();
    return;
  }

  const outcome = validateAll();
  if (!outcome.valid) {
    showFormNotice(outcome.count);
    focusControl(outcome.firstInvalid);
    return;
  }
  hideFormNotice();
  const payload = collectPayload();
  const display = collectDisplayValues();
  if (state.compareMode === "editing-b") {
    state.lastDisplay = display;
    runScenarioComparison(payload, display);
  } else {
    state.lastDisplay = display;
    runAssessment(payload);
  }
});

form.addEventListener("input", (event) => {
  const name = event.target?.name;
  if (!name) return;
  if (["loan_amnt", "person_income", "loan_percent_income"].includes(name)) updateRatioLive();

  const field = FIELD_BY_NAME[name];
  const wrap = form.querySelector(`[data-field="${name}"]`);
  if (field && wrap?.classList.contains("invalid")) {
    const result = validateField(field);
    if (result.valid) clearFieldError(name);
    else setFieldError(name, result.message);
  }
});

form.addEventListener("change", (event) => {
  const name = event.target?.name;
  if (!name) return;
  const wrap = form.querySelector(`[data-field="${name}"]`);
  const isDiscrete = event.target.type === "radio" || event.target.tagName === "SELECT";
  if (wrap?.classList.contains("invalid") && isDiscrete && event.target.value !== "") {
    clearFieldError(name);
  }
});

form.addEventListener("click", (event) => {
  if (!event.target.closest("[data-action='compute-ratio']")) return;
  const loanRaw = form.elements["loan_amnt"]?.value;
  const incomeRaw = form.elements["person_income"]?.value;
  const loan = Number(loanRaw);
  const income = Number(incomeRaw);
  if (!loanRaw || !incomeRaw || !Number.isFinite(loan) || !Number.isFinite(income) || income <= 0) {
    showToast("Enter the loan amount and annual income first");
    return;
  }
  const ratio = loan / income;
  form.elements["loan_percent_income"].value = Math.round(ratio * 10000) / 10000;
  clearFieldError("loan_percent_income");
  updateRatioLive();
  showToast("Loan-to-income ratio computed from the entered figures");
});

document.getElementById("statusChip").addEventListener("click", checkServiceStatus);

/* ---------- 17 · Navigation spy ---------- */

function setupNavSpy() {
  const links = [...document.querySelectorAll(".nav a")];
  const linkBySection = new Map(links.map((link) => [link.hash.slice(1), link]));
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const link = linkBySection.get(entry.target.id);
      if (!link) return;
      links.forEach((l) => l.removeAttribute("aria-current"));
      link.setAttribute("aria-current", "true");
    });
  }, { rootMargin: "-30% 0px -60% 0px" });

  ["assessment", "explainability", "model"].forEach((id) => {
    const section = document.getElementById(id);
    if (section) observer.observe(section);
  });
}

/* ---------- 17b · Hand-off to the full attribution page ----------
   The full page (attribution.html) re-requests /explain itself. It only needs
   the scored payload(s) and display currency, which we park in localStorage
   right before navigating. Everything is wrapped in try/catch so a blocked
   storage never breaks the main page. */

const ATTRIBUTION_STORAGE_KEY = "credence.attribution.v1";

function saveAttributionHandoff() {
  try {
    const single = state.lastPayload && state.lastResponse
      ? [makeScenarioSnapshot(state.lastPayload, state.lastDisplay, state.lastResponse, state.assessedAt)]
      : [];
    const list = state.scenarios.length > 1 ? state.scenarios : single;
    const scenarios = list.map((scenario, index) => {
      const code = scenario.display?.currency ?? "USD";
      const cur = CURRENCIES.find((c) => c.code === code) ?? CURRENCIES[0];
      return {
        label: scenarioLabel(index),
        payload: scenario.payload,
        response: scenario.response,
        currency: { code: cur.code, symbol: cur.symbol, rate: cur.rate },
        assessedAt: scenario.assessedAt instanceof Date ? scenario.assessedAt.toISOString() : null,
      };
    });
    localStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify({ version: 1, savedAt: Date.now(), scenarios }));
  } catch (error) {
    console.warn("[Credence] Could not hand attribution data to the full page:", error);
  }
}

document.querySelectorAll("[data-open-attribution]").forEach((link) => {
  link.addEventListener("click", saveAttributionHandoff);
});

/* ---------- 18 · Boot ---------- */

function init() {
  buildForm();
  renderCurrencyBar();
  updateMoneyAffixes();
  loadExchangeRates();
  renderEmptyState();
  renderExplainability(null);
  updateRatioLive();
  checkServiceStatus();
  probeExplainEndpoint();   // ← SHAP addition
  setupNavSpy();
  document.getElementById("year").textContent = String(new Date().getFullYear());
}

init();