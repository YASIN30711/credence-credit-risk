"use strict";

/* ============================================================
   Credence — NEON effects (dependency-free, except optional Lenis)
   Smooth scroll · ElectricLogo · VaporType · BranchedMenu ·
   MagicBento · Magnet · BorderGlow · HexagonalVault · cursor glow.
   Everything is additive: it only decorates existing markup and
   never touches the assessment logic in app.js.
   ============================================================ */

(() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const isAttribution = /attribution\.html$/.test(location.pathname);
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const rnd = Math.random;

  /* ---------- shared pointer tracking ---------- */

  const pointer = { x: -9999, y: -9999, inside: false };
  const pointerSubs = [];
  let pointerRaf = 0;
  const onPointer = (fn) => pointerSubs.push(fn);

  addEventListener("pointermove", (e) => {
    pointer.x = e.clientX; pointer.y = e.clientY; pointer.inside = true;
    if (!pointerRaf) pointerRaf = requestAnimationFrame(() => { pointerRaf = 0; pointerSubs.forEach((fn) => fn(pointer)); });
  }, { passive: true });
  document.documentElement.addEventListener("pointerleave", () => {
    pointer.inside = false; pointer.x = pointer.y = -9999;
    pointerSubs.forEach((fn) => fn(pointer));
  });

  /* ---------- smooth scrolling (Lenis, with graceful fallback) ---------- */

  let lenis = null;
  function smoothScroll() {
    if (reduced || typeof window.Lenis !== "function") return;
    lenis = new window.Lenis({ duration: 1.15, smoothWheel: true, easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)) });
    const loop = (time) => { lenis.raf(time); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);

    // in-page anchors → animated scroll (keeps the sticky header clear)
    document.addEventListener("click", (e) => {
      const a = e.target.closest('a[href^="#"]');
      if (!a || a.getAttribute("href").length < 2) return;
      const target = document.querySelector(a.getAttribute("href"));
      if (!target) return;
      e.preventDefault();
      lenis.scrollTo(target, { offset: -76 });
      history.pushState(null, "", a.getAttribute("href"));
    });
  }
  function scrollToSelector(sel) {
    const target = document.querySelector(sel);
    if (!target) return;
    if (lenis) lenis.scrollTo(target, { offset: -76 });
    else target.scrollIntoView({ behavior: "smooth" });
  }

  /* ---------- cursor glow ---------- */

  function cursorGlow() {
    if (!finePointer || reduced) return;
    const node = document.createElement("div");
    node.className = "cursor-glow";
    node.setAttribute("aria-hidden", "true");
    document.body.append(node);
    let x = innerWidth / 2, y = innerHeight / 2, tx = x, ty = y, raf = 0;
    const loop = () => {
      x += (tx - x) * 0.12; y += (ty - y) * 0.12;
      node.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.5 ? requestAnimationFrame(loop) : 0;
    };
    onPointer((p) => {
      node.classList.toggle("is-on", p.inside);
      if (!p.inside) return;
      tx = p.x; ty = p.y;
      if (!raf) raf = requestAnimationFrame(loop);
    });
  }

  /* ---------- Magnet: elements snap toward the cursor ---------- */

  function magnet({ padding = 90, strength = 3, max = 16 } = {}) {
    if (!finePointer || reduced) return;
    const SEL = ".btn, .nav a, .arrow-link, .status-chip, .menu-btn, .wordmark, [data-magnet]";
    const state = new Map(); // el → {x, y, tx, ty}
    let raf = 0;

    const aim = () => {
      document.querySelectorAll(SEL).forEach((el) => {
        if (el.disabled || el.closest("[hidden]")) return;
        const r = el.getBoundingClientRect();
        if (r.bottom < -padding || r.top > innerHeight + padding) return;
        const dx = pointer.x - (r.left + r.width / 2);
        const dy = pointer.y - (r.top + r.height / 2);
        const near = pointer.inside && Math.abs(dx) < r.width / 2 + padding && Math.abs(dy) < r.height / 2 + padding;
        let s = state.get(el);
        if (!s && !near) return;
        if (!s) { s = { x: 0, y: 0, tx: 0, ty: 0 }; state.set(el, s); }
        s.tx = near ? clamp(dx / strength, -max, max) : 0;
        s.ty = near ? clamp(dy / strength, -max, max) : 0;
      });
      if (!raf) raf = requestAnimationFrame(step);
    };

    const step = () => {
      let moving = false;
      state.forEach((s, el) => {
        s.x += (s.tx - s.x) * 0.18; s.y += (s.ty - s.y) * 0.18;
        if (Math.abs(s.tx - s.x) < 0.05 && Math.abs(s.ty - s.y) < 0.05 && s.tx === 0 && s.ty === 0) {
          el.style.translate = ""; state.delete(el); return;
        }
        el.style.translate = `${s.x.toFixed(2)}px ${s.y.toFixed(2)}px`;
        moving = true;
      });
      raf = moving ? requestAnimationFrame(step) : 0;
    };
    onPointer(aim);
  }

  /* ---------- BorderGlow: neon edge that follows the pointer ---------- */

  const GLOW_SELECTOR = ".xpanel, .result, .analyzing, .stat, .chart-card, .comparison-scenario-card, .error-panel, .bento-card";

  function borderGlow({ edgeSensitivity = 30 } = {}) {
    if (!finePointer) return;
    const update = () => {
      document.querySelectorAll(".bglow").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) return;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const dx = pointer.x - cx, dy = pointer.y - cy;
        const outX = Math.max(r.left - pointer.x, 0, pointer.x - r.right);
        const outY = Math.max(r.top - pointer.y, 0, pointer.y - r.bottom);
        const out = Math.hypot(outX, outY);
        if (!pointer.inside || out > 44) { el.style.setProperty("--gi", "0"); return; }
        const reach = Math.max(70, (edgeSensitivity / 100) * Math.min(r.width, r.height));
        const edge = out > 0 ? 0 : Math.min(pointer.x - r.left, r.right - pointer.x, pointer.y - r.top, r.bottom - pointer.y);
        const near = out > 0 ? 1 - out / 44 : 1 - clamp(edge / reach, 0, 1);
        const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
        el.style.setProperty("--ga", `${angle.toFixed(1)}deg`);
        el.style.setProperty("--gi", clamp(near, 0, 1).toFixed(3));
      });
    };
    onPointer(update);
  }

  /* tag dynamic nodes (cards rendered later by app.js) */
  function tagger() {
    const run = () => {
      document.querySelectorAll(GLOW_SELECTOR).forEach((el) => el.classList.add("bglow"));
      document.querySelectorAll(".table-wrap, .wf-scroll, .comparison-matrix-wrap, select, .bm-panel")
        .forEach((el) => el.setAttribute("data-lenis-prevent", ""));
    };
    run();
    let raf = 0;
    new MutationObserver(() => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; run(); }); })
      .observe(document.body, { childList: true, subtree: true });
  }

  /* ---------- VaporType: headline that condenses out of vapour ---------- */

  function vaporType(el, { from = [192, 132, 252], via = [244, 114, 182], to = [56, 189, 248] } = {}) {
    if (!el || reduced) return;
    const text = el.textContent;
    el.setAttribute("aria-label", text.replace(/ /g, " ").trim());
    const words = text.split(/ +/);
    const total = text.replace(/ +/g, "").length;
    const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
    const colorAt = (t) => {
      const c = t < 0.5 ? mix(from, via, t * 2) : mix(via, to, (t - 0.5) * 2);
      return `rgb(${c[0]} ${c[1]} ${c[2]})`;
    };

    el.replaceChildren();
    let i = 0;
    words.forEach((word, w) => {
      const wordNode = document.createElement("span");
      wordNode.className = "vapor-word";
      wordNode.setAttribute("aria-hidden", "true");
      for (const ch of word) {
        const c = document.createElement("span");
        c.className = "vapor-char";
        c.textContent = ch;
        c.style.setProperty("--i", String(i));
        c.style.color = colorAt(i / Math.max(1, total - 1));
        i += 1;
        wordNode.append(c);
      }
      el.append(wordNode);
      if (w < words.length - 1) el.append(document.createTextNode(" "));
    });
    el.classList.add("vapor");

    // hover: letters evaporate, then re-condense
    el.addEventListener("pointerover", (e) => {
      const c = e.target.closest(".vapor-char");
      if (!c || c.classList.contains("is-vapor")) return;
      c.classList.remove("is-back");
      c.classList.add("is-vapor");
      c.addEventListener("animationend", () => {
        c.classList.remove("is-vapor");
        c.classList.add("is-back");
      }, { once: true });
    });

    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { el.classList.add("is-in"); io.disconnect(); }
    }, { threshold: 0.1 });
    io.observe(el);
  }

  /* ---------- ElectricLogo: crackling arcs around the mark ---------- */

  function electricLogo(host, opts = {}) {
    if (!host) return;
    const {
      color = "#ecc7ff", glowColor = "#ad6dff", scale = 0.7, strands = 4, bend = 0.6,
      crackle = 1.5, arcs = 1, speed = 2.5, interactive = true,
    } = opts;
    const canvas = host.querySelector("canvas");
    const img = host.querySelector("img");
    const ctx = canvas.getContext("2d");
    let W = 0, H = 0, bolts = [], lastRoll = 0, lastDraw = 0, visible = true, raf = 0;

    function resize() {
      const r = host.getBoundingClientRect();
      const dpr = Math.min(2, devicePixelRatio || 1);
      W = r.width; H = r.height;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const size = Math.min(W, H) * scale * 0.62;
      img.style.width = img.style.height = `${size}px`;
    }
    const ringRadius = () => Math.min(W, H) * scale * 0.62 * 0.58;
    const ringPoint = (a, k = 1) => ({ x: W / 2 + Math.cos(a) * ringRadius() * k, y: H / 2 + Math.sin(a) * ringRadius() * k });

    function rollBolts() {
      bolts = [];
      const count = Math.max(1, Math.round(arcs)) + 1;
      for (let i = 0; i < count; i += 1) {
        const a1 = rnd() * Math.PI * 2;
        const a2 = a1 + Math.PI * (0.55 + rnd() * 0.9);
        bolts.push({ a: ringPoint(a1, 1 + rnd() * 0.25), b: ringPoint(a2, 1 + rnd() * 0.25), side: rnd() < 0.5 ? -1 : 1 });
      }
    }

    function path(a, b, side, wobble) {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const nx = -(b.y - a.y) / (len || 1), ny = (b.x - a.x) / (len || 1);
      const segs = 18, pts = [];
      for (let i = 0; i <= segs; i += 1) {
        const t = i / segs;
        const bow = Math.sin(Math.PI * t) * len * 0.22 * bend * side;
        const jitter = (rnd() - 0.5) * wobble * Math.sin(Math.PI * t);
        pts.push({ x: a.x + (b.x - a.x) * t + nx * (bow + jitter), y: a.y + (b.y - a.y) * t + ny * (bow + jitter) });
      }
      return pts;
    }

    function stroke(pts, width, alpha, col, blur) {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.globalAlpha = alpha; ctx.strokeStyle = col; ctx.lineWidth = width;
      ctx.shadowColor = glowColor; ctx.shadowBlur = blur;
      ctx.stroke();
    }

    function draw(now) {
      if (!visible) { raf = 0; return; }
      raf = requestAnimationFrame(draw);
      if (now - lastDraw < 33) return;
      lastDraw = now;
      if (now - lastRoll > (900 / speed) || !bolts.length) { rollBolts(); lastRoll = now; }

      ctx.clearRect(0, 0, W, H);
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.globalCompositeOperation = "lighter";

      const list = bolts.map((b) => ({ ...b }));
      if (interactive && pointer.inside) {
        const r = host.getBoundingClientRect();
        const px = pointer.x - r.left, py = pointer.y - r.top;
        if (px > -50 && px < W + 50 && py > -50 && py < H + 50) {
          const ang = Math.atan2(py - H / 2, px - W / 2);
          list.push({ a: ringPoint(ang, 1.05), b: { x: clamp(px, 8, W - 8), y: clamp(py, 8, H - 8) }, side: rnd() < 0.5 ? -1 : 1, hot: true });
        }
      }

      list.forEach((bolt) => {
        const len = Math.hypot(bolt.b.x - bolt.a.x, bolt.b.y - bolt.a.y);
        for (let s = 0; s < strands; s += 1) {
          const pts = path(bolt.a, bolt.b, bolt.side, len * 0.1 * crackle * (1 + s * 0.25));
          const lead = s === 0;
          stroke(pts, lead ? 3.6 : 2, (lead ? 0.28 : 0.12) * (bolt.hot ? 1.5 : 1), glowColor, 22);
          stroke(pts, lead ? 1.3 : 0.7, lead ? 0.95 : 0.5, color, 8);
        }
      });
      ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.globalCompositeOperation = "source-over";
    }

    resize();
    new ResizeObserver(resize).observe(host);
    if (reduced) { rollBolts(); draw(performance.now()); cancelAnimationFrame(raf); return; }
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && !raf) raf = requestAnimationFrame(draw);
    }).observe(host);
    raf = requestAnimationFrame(draw);
  }

  /* ---------- HexagonalVault: living hex lattice with a glowing core ---------- */

  function hexVault(host) {
    if (!host) return;
    const canvas = host.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    const S = 44;                       // hex radius
    let W = 0, H = 0, cells = [], visible = true, raf = 0, last = 0;

    function resize() {
      const r = host.getBoundingClientRect();
      const dpr = Math.min(2, devicePixelRatio || 1);
      W = r.width; H = r.height;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cells = [];
      const w = Math.sqrt(3) * S;
      for (let row = -1; row * S * 1.5 < H + S; row += 1) {
        for (let col = -1; col * w < W + w; col += 1) cells.push({ x: col * w + (row % 2 ? w / 2 : 0), y: row * S * 1.5 });
      }
    }

    function hexPath(x, y, r, rot = Math.PI / 6) {
      ctx.beginPath();
      for (let i = 0; i < 6; i += 1) {
        const a = rot + (Math.PI / 3) * i;
        i ? ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r) : ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      }
      ctx.closePath();
    }

    function draw(now) {
      if (!visible) { raf = 0; return; }
      raf = requestAnimationFrame(draw);
      if (now - last < 30) return;
      last = now;
      const t = now / 1000;
      const rect = host.getBoundingClientRect();
      const px = pointer.x - rect.left, py = pointer.y - rect.top;
      const cx = W / 2, cy = H / 2;
      const maxD = Math.hypot(W, H) / 2;
      const ring = ((t * 0.16) % 1) * maxD;

      ctx.clearRect(0, 0, W, H);
      ctx.lineWidth = 1;
      for (const c of cells) {
        const dp = pointer.inside ? Math.hypot(c.x - px, c.y - py) : 9999;
        const dc = Math.hypot(c.x - cx, c.y - cy);
        let a = 0.07 + 0.3 * Math.max(0, 1 - dp / 220);
        a += 0.28 * Math.exp(-(((dc - ring) / 44) ** 2));
        ctx.strokeStyle = `rgba(192, 132, 252, ${Math.min(a, 0.7).toFixed(3)})`;
        hexPath(c.x, c.y, S - 2);
        ctx.stroke();
        if (a > 0.3) { ctx.fillStyle = `rgba(244, 114, 182, ${((a - 0.3) * 0.25).toFixed(3)})`; ctx.fill(); }
      }

      // the vault: nested hexagons around a glowing core
      const pulse = 1 + 0.035 * Math.sin(t * 1.6);
      const R = Math.min(W, H) * 0.19 * pulse;
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 2.4);
      glow.addColorStop(0, "rgba(192,132,252,0.45)"); glow.addColorStop(1, "rgba(192,132,252,0)");
      ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

      ctx.setLineDash([6, 10]); ctx.lineDashOffset = -t * 14;
      ctx.strokeStyle = "rgba(56,189,248,0.55)"; ctx.lineWidth = 1.3;
      hexPath(cx, cy, R * 1.55, t * 0.05); ctx.stroke();
      ctx.setLineDash([]);

      [[1.18, 0.3], [0.86, 0.5]].forEach(([k, al]) => {
        ctx.strokeStyle = `rgba(244,114,182,${al})`; ctx.lineWidth = 1.6; hexPath(cx, cy, R * k); ctx.stroke();
      });
      const core = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
      core.addColorStop(0, "#c084fc"); core.addColorStop(1, "#f472b6");
      ctx.shadowColor = "#c084fc"; ctx.shadowBlur = 34;
      ctx.fillStyle = core; ctx.globalAlpha = 0.85; hexPath(cx, cy, R * 0.5); ctx.fill();
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = 1.2; hexPath(cx, cy, R * 0.34); ctx.stroke();
    }

    resize();
    new ResizeObserver(resize).observe(host);
    if (reduced) { draw(performance.now()); cancelAnimationFrame(raf); return; }
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && !raf) raf = requestAnimationFrame(draw);
    }).observe(host);
    raf = requestAnimationFrame(draw);
  }

  /* ---------- MagicBento: spotlight + click ripple ---------- */

  function bento(grid, { spotlightRadius = 300 } = {}) {
    if (!grid) return;
    const cards = [...grid.querySelectorAll(".bento-card")];
    cards.forEach((card) => {
      const spot = document.createElement("span");
      spot.className = "bento-spot";
      spot.setAttribute("aria-hidden", "true");
      card.prepend(spot);
    });
    onPointer((p) => {
      cards.forEach((card) => {
        const r = card.getBoundingClientRect();
        const dx = Math.max(r.left - p.x, 0, p.x - r.right);
        const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
        const i = p.inside ? clamp(1 - Math.hypot(dx, dy) / spotlightRadius, 0, 1) : 0;
        card.style.setProperty("--mx", `${p.x - r.left}px`);
        card.style.setProperty("--my", `${p.y - r.top}px`);
        card.style.setProperty("--si", i.toFixed(3));
      });
    });
    grid.addEventListener("click", (e) => {
      const card = e.target.closest(".bento-card");
      if (!card || reduced) return;
      const r = card.getBoundingClientRect();
      const ripple = document.createElement("span");
      ripple.className = "bento-ripple";
      ripple.style.left = `${e.clientX - r.left}px`;
      ripple.style.top = `${e.clientY - r.top}px`;
      card.append(ripple);
      ripple.addEventListener("animationend", () => ripple.remove());
    });
  }

  /* ---------- BranchedMenu: animated tree navigation ---------- */

  const ICONS = {
    form: '<path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4M10 12h6M10 16h6"/>',
    gauge: '<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/><circle cx="12" cy="16" r="1.2"/>',
    spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 17l.7 1.8L21.5 19.5l-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z"/>',
    bars: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
    chip: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  const MENU = [
    { label: "Platform", children: [
      { value: "assessment", label: "Assessment", icon: "form", target: "#assessment" },
      { value: "result", label: "Risk outcome", icon: "gauge", target: "#result" },
      { value: "explainability", label: "Explainability", icon: "spark", target: "#explainability" },
    ] },
    { label: "Reference", children: [
      { value: "attribution", label: "Feature attribution", icon: "bars" },
      { value: "model", label: "Model & system", icon: "chip", target: "#model" },
    ] },
  ];

  function branchedMenu() {
    const bar = document.querySelector(".topbar-inner");
    if (!bar) return;

    const trigger = document.createElement("button");
    trigger.type = "button"; trigger.className = "menu-btn";
    trigger.setAttribute("aria-haspopup", "dialog"); trigger.setAttribute("aria-expanded", "false");
    trigger.innerHTML = '<span class="menu-lines" aria-hidden="true"><i></i><i></i></span>Menu';
    bar.append(trigger);

    const overlay = document.createElement("div");
    overlay.className = "bm-overlay";
    overlay.innerHTML =
      '<div class="bm-backdrop"></div>' +
      '<aside class="bm-panel" role="dialog" aria-modal="true" aria-label="Site navigation">' +
      '<div class="bm-head"><span class="bm-kicker">NAVIGATE</span><button type="button" class="bm-close">Close</button></div>' +
      '<nav class="bm-tree" aria-label="Site"><ul class="bm-root"></ul></nav>' +
      '<p class="bm-foot">Credence · credit-risk decision support</p></aside>';
    document.body.append(overlay);
    overlay.hidden = false;

    const root = overlay.querySelector(".bm-root");
    const leaves = new Map();
    MENU.forEach((group, gi) => {
      const li = document.createElement("li");
      li.className = "bm-group is-open";
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "bm-group-btn"; btn.setAttribute("aria-expanded", "true");
      btn.innerHTML = '<svg class="bm-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>';
      btn.append(group.label);
      btn.addEventListener("click", () => {
        const open = li.classList.toggle("is-open");
        btn.setAttribute("aria-expanded", String(open));
      });
      const wrap = document.createElement("div"); wrap.className = "bm-children";
      const ul = document.createElement("ul");
      group.children.forEach((item, ci) => {
        const leaf = document.createElement("li");
        leaf.className = "bm-leaf"; leaf.style.setProperty("--i", String(ci));
        const b = document.createElement("button");
        b.type = "button"; b.className = "bm-item"; b.dataset.value = item.value;
        b.innerHTML = `${icon(item.icon)}<span>${item.label}</span>`;
        b.addEventListener("click", () => select(item));
        leaf.append(b); ul.append(leaf); leaves.set(item.value, leaf);
      });
      wrap.append(ul); li.append(btn, wrap); root.append(li);
      void gi;
    });

    function setActive(value) {
      leaves.forEach((leaf, key) => {
        const on = key === value;
        leaf.classList.toggle("is-active", on);
        const b = leaf.firstElementChild;
        on ? b.setAttribute("aria-current", "true") : b.removeAttribute("aria-current");
      });
    }

    function currentSection() {
      if (isAttribution) return "attribution";
      let best = "assessment", bestTop = -Infinity;
      MENU.flatMap((g) => g.children).filter((c) => c.target).forEach((c) => {
        const node = document.querySelector(c.target);
        if (!node) return;
        const top = node.getBoundingClientRect().top;
        if (top <= innerHeight * 0.4 && top > bestTop) { best = c.value; bestTop = top; }
      });
      return best;
    }

    function open() {
      setActive(currentSection());
      overlay.classList.add("is-open");
      trigger.setAttribute("aria-expanded", "true");
      lenis?.stop();
      setTimeout(() => (overlay.querySelector(".bm-leaf.is-active .bm-item") ?? overlay.querySelector(".bm-item"))?.focus({ preventScroll: true }), 120);
    }
    function close(restore = true) {
      overlay.classList.remove("is-open");
      trigger.setAttribute("aria-expanded", "false");
      lenis?.start();
      if (restore) trigger.focus({ preventScroll: true });
    }

    function select(item) {
      setActive(item.value);
      close(false);
      if (item.value === "attribution") {
        if (isAttribution) return;
        const link = document.querySelector("[data-open-attribution]");   // app.js saves the hand-off on click
        link ? link.click() : (location.href = "static/attribution.html");
        return;
      }
      if (isAttribution) { location.href = `/${item.target}`; return; }
      setTimeout(() => scrollToSelector(item.target), 250);
    }

    trigger.addEventListener("click", open);
    overlay.querySelector(".bm-close").addEventListener("click", () => close());
    overlay.querySelector(".bm-backdrop").addEventListener("click", () => close());
    addEventListener("keydown", (e) => {
      if (!overlay.classList.contains("is-open")) return;
      if (e.key === "Escape") close();
      if (e.key === "Tab") {
        const f = [...overlay.querySelectorAll("button")].filter((n) => n.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], lastEl = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
        else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
      }
    });
  }

  /* ---------- boot ---------- */

  function boot() {
    smoothScroll();
    cursorGlow();
    branchedMenu();
    vaporType(document.querySelector(".hero h1, .attr-page .page-head h1"));
    electricLogo(document.getElementById("electricLogo"), {
      color: "#ecc7ff", glowColor: "#ad6dff", scale: 0.7, strands: 4, bend: 0.6, crackle: 1.5, arcs: 1, speed: 2.5, interactive: true,
    });
    hexVault(document.getElementById("vaultBg"));
    bento(document.getElementById("bentoGrid"), { spotlightRadius: 300 });
    tagger();
    borderGlow({ edgeSensitivity: 30 });
    magnet({ padding: 90, strength: 3 });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();