"use strict";

/* ============================================================
   Credence — UI kit (dependency-free)
   AnimatedContent · HoloCard · CircularCarousel
   Same props as the React versions; used by the attribution page only.
   Exposes window.CredenceUI.
   ============================================================ */

(() => {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /* ---------- AnimatedContent: children animate in one by one ---------- */

  const EASES = {
    "power1.out": "cubic-bezier(0.25, 0.46, 0.45, 0.94)",
    "power2.out": "cubic-bezier(0.215, 0.61, 0.355, 1)",
    "power3.out": "cubic-bezier(0.165, 0.84, 0.44, 1)",
    "power4.out": "cubic-bezier(0.19, 1, 0.22, 1)",
    none: "linear",
  };

  function animatedContent(container, opts = {}) {
    const {
      distance = 100, direction = "vertical", reverse = false, duration = 0.8,
      ease = "power3.out", blur = 0, stagger = 0.08, threshold = 0.1, delay = 0,
    } = opts;

    const children = [...container.children];
    const release = () => children.forEach((c) => { c.style.animation = ""; c.style.opacity = ""; });
    if (reduced || !("IntersectionObserver" in window) || !children.length) { release(); return; }

    const sign = reverse ? -1 : 1;
    const from = direction === "horizontal"
      ? `translate3d(${distance * sign}px, 0, 0)` : `translate3d(0, ${distance * sign}px, 0)`;
    const easing = EASES[ease] ?? ease;

    children.forEach((c) => { c.style.animation = "none"; c.style.opacity = "0"; });

    const play = () => {
      children.forEach((child, i) => {
        const keyframes = [
          { opacity: 0, transform: from, filter: blur ? `blur(${blur}px)` : "none" },
          { opacity: 1, transform: "translate3d(0, 0, 0)", filter: "none" },
        ];
        const anim = child.animate(keyframes, {
          duration: duration * 1000, delay: (delay + i * stagger) * 1000, easing, fill: "both",
        });
        anim.onfinish = () => { child.style.opacity = ""; anim.cancel(); };
      });
    };

    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); play(); }
    }, { threshold });
    io.observe(container);
  }

  function initAnimatedContent(scope = document) {
    scope.querySelectorAll("[data-animate]:not([data-animate-ready])").forEach((node) => {
      node.setAttribute("data-animate-ready", "");
      const d = node.dataset;
      animatedContent(node, {
        distance: d.distance !== undefined ? Number(d.distance) : undefined,
        direction: d.direction, duration: d.duration !== undefined ? Number(d.duration) : undefined,
        ease: d.ease, blur: d.blur !== undefined ? Number(d.blur) : undefined,
        stagger: d.stagger !== undefined ? Number(d.stagger) : undefined,
        threshold: d.threshold !== undefined ? Number(d.threshold) : undefined,
        delay: d.delay !== undefined ? Number(d.delay) : undefined,
      });
    });
  }

  /* ---------- HoloCard: pointer-tracked holographic foil ---------- */

  function holoCard(mount, { image, alt = "", preset = "bursts" } = {}) {
    const card = document.createElement("div");
    card.className = "holo";
    card.dataset.preset = preset;
    card.tabIndex = 0;
    card.innerHTML =
      '<div class="holo__rotator">' +
      '<img class="holo__img" draggable="false">' +
      '<div class="holo__shine"></div><div class="holo__glare"></div></div>';
    const img = card.querySelector("img");
    img.src = image;
    img.alt = alt;
    mount.replaceChildren(card);

    let raf = 0;
    const set = (x, y) => {
      const px = clamp(x, 0, 100), py = clamp(y, 0, 100);
      const s = card.style;
      s.setProperty("--px", `${px}%`);
      s.setProperty("--py", `${py}%`);
      s.setProperty("--rx", `${((50 - px) / 50) * 12}deg`);
      s.setProperty("--ry", `${((py - 50) / 50) * 12}deg`);
      s.setProperty("--bx", `${37 + (px / 100) * 26}%`);
      s.setProperty("--by", `${33 + (py / 100) * 34}%`);
      s.setProperty("--hyp", String(clamp(Math.hypot(py - 50, px - 50) / 50, 0, 1)));
    };
    const onMove = (e) => {
      const r = card.getBoundingClientRect();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => set(((e.clientX - r.left) / r.width) * 100, ((e.clientY - r.top) / r.height) * 100));
      card.classList.add("is-active");
    };
    const onLeave = () => { cancelAnimationFrame(raf); card.classList.remove("is-active"); set(50, 50); };
    card.addEventListener("pointermove", onMove);
    card.addEventListener("pointerleave", onLeave);
    card.addEventListener("pointercancel", onLeave);
    card.addEventListener("blur", onLeave);
    card.addEventListener("keydown", (e) => {
      const step = 14;
      const cur = [parseFloat(card.style.getPropertyValue("--px")) || 50, parseFloat(card.style.getPropertyValue("--py")) || 50];
      const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!move) return;
      e.preventDefault();
      card.classList.add("is-active");
      set(cur[0] + move[0], cur[1] + move[1]);
    });
    set(50, 50);
    return card;
  }

  /* ---------- CircularCarousel: 3D cylinder / ring selector ---------- */

  function circularCarousel(mount, opts = {}) {
    const {
      items = [], preset = "cylinder", intro = "rise", cardWidth = 220, aspectRatio = 1,
      speed = 14, captions = true, selected = 0, onSelect = () => {}, label = "Carousel",
    } = opts;
    const n = items.length;
    if (!n) return null;

    const cardHeight = Math.round(cardWidth / aspectRatio);
    // Few items: fan them out along a partial arc (no wrap) so neighbours stay visible.
    const step = n >= 9 ? 360 / n : preset === "ring" ? 46 : 40;
    const wraps = n * step >= 359;
    const radius = (cardWidth * (preset === "ring" ? 1.2 : 1.1)) / (2 * Math.sin((step * Math.PI) / 360));

    const stage = document.createElement("div");
    stage.className = "cc";
    stage.dataset.preset = preset;
    stage.setAttribute("role", "radiogroup");
    stage.setAttribute("aria-label", label);
    stage.style.setProperty("--cc-w", `${cardWidth}px`);
    stage.style.setProperty("--cc-h", `${cardHeight}px`);

    const ring = document.createElement("div");
    ring.className = "cc__ring";
    stage.append(ring);

    const cards = items.map((item, i) => {
      const slot = document.createElement("div");
      slot.className = "cc__slot";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cc__card";
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-label", [item.title, item.subtitle].filter(Boolean).join(" — "));
      btn.style.setProperty("--i", String(i));
      const img = document.createElement("img");
      img.src = item.src; img.alt = item.alt ?? ""; img.draggable = false;
      btn.append(img);
      if (captions) {
        const cap = document.createElement("span");
        cap.className = "cc__cap";
        const t = document.createElement("strong"); t.textContent = item.title ?? "";
        const s = document.createElement("small"); s.textContent = item.subtitle ?? "";
        cap.append(t, s);
        btn.append(cap);
      }
      slot.append(btn);
      ring.append(slot);
      btn.addEventListener("click", () => { if (!dragMoved) select(i, true); });
      return { slot, btn };
    });

    mount.replaceChildren(stage);

    let current = clamp(selected, 0, n - 1);
    let angle = -current * step;      // rendered rotation of the ring
    let target = angle;
    let raf = 0, last = 0;
    let dragging = false, dragMoved = false, startX = 0, startAngle = 0, lastX = 0, lastT = 0, velocity = 0;

    const norm = (i) => (wraps ? ((i % n) + n) % n : clamp(i, 0, n - 1));
    const nearest = (a) => norm(Math.round(-a / step));

    function paint() {
      ring.style.transform = `translateZ(${-radius}px) rotateY(${angle}deg)`;
      cards.forEach(({ slot, btn }, i) => {
        slot.style.transform = `rotateY(${i * step}deg) translateZ(${radius}px)`;
        // 1 = facing viewer, -1 = directly behind
        const facing = Math.cos(((i * step + angle) * Math.PI) / 180);
        const vis = clamp((facing - 0.3) / 0.7, 0.18, 1);
        btn.style.setProperty("--vis", vis.toFixed(3));
        btn.style.setProperty("--front", clamp(facing, 0, 1).toFixed(3));
        slot.style.zIndex = String(Math.round((facing + 1) * 50));
      });
    }

    function tick(now) {
      const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
      last = now;
      if (!dragging) {
        angle += (target - angle) * (1 - Math.exp(-speed * 0.5 * dt));
        if (Math.abs(target - angle) < 0.02) angle = target;
      }
      paint();
      raf = Math.abs(target - angle) > 0.02 || dragging ? requestAnimationFrame(tick) : 0;
    }
    const kick = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); } };

    function sync() {
      cards.forEach(({ btn }, i) => {
        const on = i === current;
        btn.classList.toggle("is-selected", on);
        btn.setAttribute("aria-checked", on ? "true" : "false");
        btn.tabIndex = on ? 0 : -1;
      });
    }

    // Rotate the shortest way round to the card at `index`.
    function rotateTo(index) {
      const base = -index * step;
      target = wraps ? base + Math.round((angle - base) / 360) * 360 : base;
      kick();
    }

    function select(index, emit) {
      const next = norm(index);
      const changed = next !== current;
      current = next;
      rotateTo(next);
      sync();
      if (emit && changed) onSelect(items[next], next);
    }

    /* drag / swipe */
    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true; dragMoved = false;
      startX = lastX = e.clientX; startAngle = angle; lastT = performance.now(); velocity = 0;
      stage.classList.add("is-dragging");
      kick();
    });
    window.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 4 && !dragMoved) { dragMoved = true; try { stage.setPointerCapture(e.pointerId); } catch { /* noop */ } }
      if (!dragMoved) return;
      const perPx = step / (cardWidth * 0.9);
      const now = performance.now();
      velocity = ((e.clientX - lastX) * perPx) / Math.max(1, now - lastT);
      lastX = e.clientX; lastT = now;
      angle = startAngle + dx * perPx;
      if (!wraps) angle = clamp(angle, -(n - 1) * step - 12, 12);
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      stage.classList.remove("is-dragging");
      if (dragMoved) {
        const projected = angle + velocity * 140;   // a little fling
        select(nearest(projected), true);
        // the click that follows pointerup must not select a card
        setTimeout(() => { dragMoved = false; }, 0);
      }
    };
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);

    stage.addEventListener("keydown", (e) => {
      const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!dir && e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      const next = norm(e.key === "Home" ? 0 : e.key === "End" ? n - 1 : current + dir);
      select(next, true);
      cards[next].btn.focus({ preventScroll: true });
    });
    stage.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || Math.abs(e.deltaX) < 30) return;
      e.preventDefault();
      select(current + (e.deltaX > 0 ? 1 : -1), true);
    }, { passive: false });

    /* intro */
    paint(); sync();
    if (!reduced && intro && intro !== "none") {
      stage.classList.add(`intro-${intro}`);
      cards.forEach(({ btn }, i) => btn.style.setProperty("--d", `${i * 90}ms`));
      requestAnimationFrame(() => requestAnimationFrame(() => stage.classList.add("is-in")));
      if (intro === "spin") { angle = target - 180; kick(); }
    } else {
      stage.classList.add("is-in");
    }

    return {
      get index() { return current; },
      setIndex(i) { if (i !== current) select(i, false); },
      destroy() { cancelAnimationFrame(raf); mount.replaceChildren(); },
    };
  }

  window.CredenceUI = { animatedContent, initAnimatedContent, holoCard, circularCarousel };
  document.addEventListener("DOMContentLoaded", () => initAnimatedContent());
  if (document.readyState !== "loading") initAnimatedContent();
})();