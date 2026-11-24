/*
 * latch.js — make scroll-triggered animations "stick" in their completed state.
 *
 * Two ways to use it:
 *   1. Automated (recommended): capture.mjs injects this with addInitScript(),
 *      so it runs BEFORE any site script and can wrap IntersectionObserver.
 *   2. Manual: paste the whole file into the Chrome DevTools console, then run
 *         await __latch.run({ wait: 10000 })
 *      and afterwards Cmd/Ctrl+Shift+P → "Capture full size screenshot".
 *
 * Layers:
 *   A. IntersectionObserver latch: once a target has intersected, later
 *      "left the viewport" entries are dropped, so the site never resets it.
 *   B. Time gate + freeze: every element must have been on screen for the full
 *      wait (default 10 s) before it is frozen. Freezing finishes finite Web
 *      Animations, plays videos that run once to their last frame, and pins
 *      animated properties as inline !important values.
 *   C. Guard: a MutationObserver restores class / style / SVG attributes /
 *      short text of frozen elements if a scroll handler (jQuery, GSAP,
 *      custom) tries to undo them.
 */
(() => {
  if (window.__latch) return;

  const BASE_PROPS = [
    'opacity', 'transform', 'translate', 'rotate', 'scale', 'visibility',
    'clip-path', 'filter', 'stroke-dashoffset', 'stroke-dasharray',
  ];
  const SVG_ATTRS = [
    'd', 'points', 'transform', 'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-dashoffset',
    'stroke-dasharray', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'offset',
    'x1', 'x2', 'y1', 'y2', 'style', 'class',
  ];
  const MARKERS = [
    '[data-aos]', '[data-scroll]', '[data-animate]', '[data-animation]',
    '[data-sal]', '[data-reveal]', '[data-w-id]', '.wow', '.reveal',
    '[class*="animate"]', '[class*="fade"]', '[class*="slide-"]', '[class*="inview"]', '[class*="in-view"]',
  ].join(',');

  const seen = new WeakSet();       // targets that have intersected at least once
  const watched = new Set();        // every target any IntersectionObserver watches
  const firstSeen = new WeakMap();  // el -> performance.now() when first on screen
  const frozen = new Map();         // el -> snapshot | null (null = looked at, nothing to pin)
  const stats = { intersections: 0, lastIntersectionAt: 0, guardRestores: 0 };

  /* ---------- A. IntersectionObserver latch ---------- */
  const NativeIO = window.IntersectionObserver;
  if (NativeIO && !NativeIO.__latched) {
    const LatchedIO = function IntersectionObserver(callback, options) {
      const wrapped = (entries, observer) => {
        const keep = [];
        for (const e of entries) {
          if (e.isIntersecting || e.intersectionRatio > 0) {
            if (!seen.has(e.target)) {
              seen.add(e.target);
              stats.intersections++;
              stats.lastIntersectionAt = performance.now();
            }
            keep.push(e);
          } else if (!seen.has(e.target)) {
            keep.push(e); // initial "not visible yet" report is harmless
          } // else: "left the viewport" -> drop it
        }
        if (keep.length) callback.call(observer, keep, observer);
      };
      const io = new NativeIO(wrapped, options);
      const observe = io.observe.bind(io);
      io.observe = (t) => { watched.add(t); return observe(t); };
      return io;
    };
    LatchedIO.prototype = NativeIO.prototype;
    LatchedIO.__latched = true;
    try {
      Object.defineProperty(window, 'IntersectionObserver', { value: LatchedIO, writable: true, configurable: true });
    } catch { window.IntersectionObserver = LatchedIO; }
  }

  /* ---------- helpers ---------- */
  const isFiniteAnim = (a) => {
    try { return Number.isFinite(a.effect.getComputedTiming().endTime); } catch { return false; }
  };
  const toKebab = (p) => p.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  const onScreen = (r, vh) => r.bottom > 0 && r.top < vh && (r.width > 0 || r.height > 0);
  const allEls = () => document.body ? document.body.querySelectorAll('*') : [];

  function animatedProps(anims, cs) {
    const props = new Set(BASE_PROPS);
    const tp = cs.transitionProperty;
    if (cs.transitionDuration.split(',').some((d) => parseFloat(d) > 0) && tp && tp !== 'none') {
      for (const p of tp.split(',').map((s) => s.trim())) if (p && p !== 'all') props.add(p);
    }
    for (const a of anims) {
      try {
        for (const kf of a.effect.getKeyframes()) {
          for (const k of Object.keys(kf)) {
            if (!['offset', 'easing', 'composite', 'computedOffset'].includes(k)) props.add(toKebab(k));
          }
        }
      } catch { /* exotic effect */ }
    }
    return props;
  }

  function isCandidate(el, anims, cs) {
    if (anims.length || watched.has(el) || el instanceof SVGElement || el.tagName === 'VIDEO') return true;
    if (el.hasAttribute('style')) return true; // JS-driven (jQuery.animate, GSAP, rAF counters)
    if (cs.transitionDuration.split(',').some((d) => parseFloat(d) > 0)) return true;
    try { return el.matches(MARKERS); } catch { return false; }
  }

  function snapshot(el) {
    const onlyText = el.childNodes.length > 0 && [...el.childNodes].every((n) => n.nodeType === 3);
    const attrs = {};
    for (const a of (el instanceof SVGElement ? SVG_ATTRS : ['class', 'style'])) attrs[a] = el.getAttribute(a);
    return { attrs, text: onlyText && el.textContent.length <= 40 ? el.textContent : null };
  }

  function pin(el, props, cs) {
    for (const p of props) {
      const v = cs.getPropertyValue(p);
      if (v !== '') el.style.setProperty(p, v, 'important');
    }
    el.style.setProperty('transition', 'none', 'important');
  }

  function settleVideo(v) {
    try {
      if (v.loop) { v.pause(); return; }
      if (Number.isFinite(v.duration) && v.duration > 0 && !v.ended) v.currentTime = Math.max(0, v.duration - 0.05);
      v.pause();
    } catch { /* not loaded */ }
  }

  /* ---------- B. Time gate ---------- */
  /** Record when each element was first on screen. Call after every scroll. */
  function markVisible() {
    const vh = window.innerHeight, now = performance.now();
    for (const el of allEls()) {
      if (firstSeen.has(el) || el.getClientRects().length === 0) continue;
      if (onScreen(el.getBoundingClientRect(), vh)) firstSeen.set(el, now);
    }
  }

  /** Elements that would be frozen now: on screen, top above `line`, not frozen yet. */
  function* freezeZone({ line, all }) {
    const vh = window.innerHeight;
    for (const el of allEls()) {
      if (frozen.has(el) || el.getClientRects().length === 0) continue;
      const r = el.getBoundingClientRect();
      if (!onScreen(r, vh) || (!all && r.top > vh * line)) continue;
      yield el;
    }
  }

  /** ms still needed until every element in the freeze zone has been on screen for `wait` ms. */
  function pendingWait({ wait = 10000, line = 0.5, all = false } = {}) {
    const now = performance.now();
    let need = 0;
    for (const el of freezeZone({ line, all })) {
      const t = firstSeen.has(el) ? firstSeen.get(el) : now;
      need = Math.max(need, wait - (now - t));
    }
    return Math.ceil(need);
  }

  /* ---------- B. Freeze ---------- */
  /** Freeze elements in the zone that have been on screen for at least `wait` ms. */
  function freezeInView({ line = 0.5, all = false, wait = 0 } = {}) {
    const now = performance.now();
    let count = 0;
    for (const el of [...freezeZone({ line, all })]) {
      if (now - (firstSeen.get(el) ?? now) < wait - 50) continue; // not long enough on screen yet
      const anims = el.getAnimations ? el.getAnimations() : [];
      const cs = getComputedStyle(el);
      if (!isCandidate(el, anims, cs)) { frozen.set(el, null); continue; }

      for (const a of anims) if (isFiniteAnim(a)) { try { a.finish(); } catch { /* */ } }
      if (el.tagName === 'VIDEO') settleVideo(el);
      if (el instanceof SVGSVGElement && el.animationsPaused && !el.animationsPaused()) {
        try { el.pauseAnimations(); } catch { /* */ }
      }
      const cs2 = getComputedStyle(el);
      pin(el, animatedProps(anims, cs2), cs2);
      frozen.set(el, snapshot(el));
      count++;
    }
    return count;
  }

  /* ---------- C. Guard ---------- */
  let restoring = false;
  const guard = new MutationObserver((records) => {
    if (restoring) return;
    restoring = true;
    try {
      for (const rec of records) {
        const el = rec.target.nodeType === 3 ? rec.target.parentNode : rec.target;
        const snap = el && frozen.get(el);
        if (!snap) continue;
        if (rec.type === 'attributes') {
          const name = rec.attributeName;
          if (!(name in snap.attrs)) continue;
          const want = snap.attrs[name];
          if (el.getAttribute(name) !== want) {
            if (want === null) el.removeAttribute(name); else el.setAttribute(name, want);
            stats.guardRestores++;
          }
        } else if (snap.text !== null && el.textContent !== snap.text) {
          el.textContent = snap.text;
          stats.guardRestores++;
        }
      }
    } finally { restoring = false; }
  });
  const startGuard = () => guard.observe(document.documentElement, {
    subtree: true, attributes: true, characterData: true, childList: true,
  });
  if (document.documentElement) startGuard();
  else document.addEventListener('readystatechange', startGuard, { once: true });

  /* ---------- library hooks ---------- */
  function freezeLibraries({ line = 0.5, all = false } = {}) {
    const vh = window.innerHeight;
    let n = 0;
    const ST = window.ScrollTrigger;
    if (ST && ST.getAll) {
      for (const st of ST.getAll()) {
        if (st.__latched || st.vars.scrub) continue; // scrubbed = position-driven, leave it
        const trg = st.trigger;
        if (trg) {
          const r = trg.getBoundingClientRect();
          if (r.bottom <= 0 || r.top >= vh || (!all && r.top > vh * line)) continue;
        }
        if (st.animation && (st.isActive || st.progress > 0 || st.animation.progress() > 0)) st.animation.progress(1);
        st.disable(false);
        st.__latched = true;
        n++;
      }
    }
    if (window.AOS && !window.AOS.__latched) {
      try { window.AOS.init({ once: true, mirror: false }); window.AOS.__latched = true; } catch { /* */ }
    }
    return n;
  }

  /** Before the final capture: stop everything that is still moving. */
  function pauseAll() {
    let n = 0;
    for (const a of document.getAnimations()) {
      try {
        if (isFiniteAnim(a)) { a.finish(); } else { a.pause(); }
        n++;
      } catch { /* */ }
    }
    for (const v of document.querySelectorAll('video')) { try { v.pause(); } catch { /* */ } }
    if (window.gsap && window.gsap.globalTimeline) window.gsap.globalTimeline.pause();
    return n;
  }

  /** Pause infinite loops (marquees, spinners, looping videos) so motion can settle. */
  function pauseLoops() {
    let n = 0;
    for (const a of document.getAnimations()) {
      if (!isFiniteAnim(a) && a.playState === 'running') { try { a.pause(); n++; } catch { /* */ } }
    }
    for (const v of document.querySelectorAll('video[loop]')) { try { v.pause(); n++; } catch { /* */ } }
    return n;
  }

  /** True while something with a defined end is still playing on screen. */
  function finiteRunningInView() {
    const vh = window.innerHeight;
    const vis = (t) => !t || !t.getBoundingClientRect || onScreen(t.getBoundingClientRect(), vh);
    const anim = document.getAnimations().some((a) =>
      isFiniteAnim(a) && (a.playState === 'running' || a.pending) && vis(a.effect && a.effect.target));
    const video = [...document.querySelectorAll('video:not([loop])')].some((v) =>
      !v.paused && !v.ended && vis(v));
    return anim || video;
  }

  /** Our own style changes must update the guard's snapshot, or it would undo them. */
  function resnap(el) { if (frozen.get(el)) frozen.set(el, snapshot(el)); }
  function hide(selectors) {
    for (const s of selectors) document.querySelectorAll(s).forEach((el) => {
      el.style.setProperty('display', 'none', 'important'); resnap(el);
    });
  }
  function unfix(selectors) {
    for (const s of selectors) document.querySelectorAll(s).forEach((el) => {
      el.style.setProperty('position', 'relative', 'important'); resnap(el);
    });
  }
  function fixedElements() {
    return [...allEls()].filter((el) => {
      const p = getComputedStyle(el).position;
      return p === 'fixed' || p === 'sticky';
    });
  }
  /**
   * Hide floating fixed elements (bottom safety/ISI drawers, cookie bars,
   * back-to-top buttons, chat bubbles). In a full-page shot Chrome draws them
   * where they sat in the FIRST viewport, i.e. stamped across page content.
   * Fixed bars docked at the very top (site headers) are kept: they render
   * correctly at the top of the page. Call with the page scrolled to the top.
   */
  function hideFloating() {
    const hidden = [];
    for (const el of allEls()) {
      if (getComputedStyle(el).position !== 'fixed' || el.getClientRects().length === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const headerAtTop = r.top <= 1 && r.height < window.innerHeight * 0.3;
      if (headerAtTop) continue;
      if (el.parentElement && el.parentElement.closest('[data-latch-hidden]')) continue;
      el.setAttribute('data-latch-hidden', '');
      el.style.setProperty('visibility', 'hidden', 'important');
      resnap(el);
      hidden.push(((el.id && '#' + el.id) || el.tagName.toLowerCase() +
        (el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : '')) +
        ` (${Math.round(r.width)}x${Math.round(r.height)} at y=${Math.round(r.top)})`);
    }
    return hidden;
  }

  /**
   * Embedded iframes (e.g. Ceros, YouTube, charts). Their content lives in
   * another document, so freezing the main page can't reach it, and many
   * embeds blank out or restart when off screen. capture.mjs photographs each
   * one while it's on screen and finished, then pastes it into the final image.
   * `occluded` = something (sticky header, drawer) covers part of it right now.
   */
  function framesInfo() {
    const vh = window.innerHeight, vw = document.documentElement.clientWidth;
    return [...document.querySelectorAll('iframe')].map((f, i) => {
      const r = f.getBoundingClientRect();
      const cs = getComputedStyle(f);
      const visible = r.width >= 20 && r.height >= 20 && cs.visibility !== 'hidden' &&
        cs.display !== 'none' && Number(cs.opacity) > 0;
      const full = r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw;
      // Only things pinned to the window (sticky header, drawer) matter: in-flow
      // overlays look the same in the final image as in this on-screen photo.
      let occluded = false;
      if (visible && full) {
        for (const [fx, fy] of [[0.5, 0.5], [0.08, 0.08], [0.92, 0.08], [0.08, 0.92], [0.92, 0.92]]) {
          let hit = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
          while (hit && hit !== f && hit !== document.body) {
            const p = getComputedStyle(hit).position;
            if (p === 'fixed' || p === 'sticky') { occluded = true; break; }
            hit = hit.parentElement;
          }
          if (occluded) break;
        }
      }
      const src = (f.getAttribute('src') || '').split('?')[0].split('/').filter(Boolean).pop() || f.title || 'iframe';
      return {
        i, src, visible, full, occluded, x: r.left, y: r.top, w: r.width, h: r.height,
        pageX: r.left + window.scrollX, pageY: r.top + window.scrollY,
      };
    }).filter((f) => f.visible);
  }

  /** Videos the current browser could not play (e.g. MP4/H.264 in bundled Chromium). */
  function brokenVideos() {
    return [...document.querySelectorAll('video')].filter((v) => {
      const r = v.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      if (v.error) return true;
      const srcs = [v.currentSrc || v.src, ...[...v.querySelectorAll('source')].map((s) => s.src)].filter(Boolean);
      return srcs.length > 0 && v.readyState === 0 && v.networkState === 3; // NETWORK_NO_SOURCE
    }).map((v) => (v.currentSrc || v.src || v.querySelector('source')?.src || '').split('/').pop());
  }

  function imagesInViewReady() {
    const vh = window.innerHeight;
    return [...document.images].every((img) => !onScreen(img.getBoundingClientRect(), vh) || img.complete);
  }

  /** In-page version for the manual console workflow. */
  async function run({ wait = 10000, step = 0.5, line = 0.5 } = {}) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
    let y = 0;
    for (;;) {
      const max = document.documentElement.scrollHeight - innerHeight;
      window.scrollTo(0, Math.min(y, max));
      await sleep(400);
      markVisible();
      const last = y >= max;
      await sleep(pendingWait({ wait, line, all: last }));
      while (finiteRunningInView()) await sleep(250);
      freezeLibraries({ line, all: last });
      freezeInView({ line, all: last, wait });
      console.log(`[latch] y=${Math.round(Math.min(y, max))} frozen=${frozen.size}`);
      if (last) break;
      y += innerHeight * step;
    }
    pauseAll();
    window.scrollTo(0, 0);
    await sleep(300);
    hideFloating();
    console.log('[latch] done — now Cmd/Ctrl+Shift+P → "Capture full size screenshot"');
  }

  window.__latch = {
    markVisible, pendingWait, freezeInView, freezeLibraries, pauseAll, pauseLoops,
    finiteRunningInView, hide, unfix, fixedElements, hideFloating, brokenVideos, framesInfo, imagesInViewReady, run,
    stats: () => ({ ...stats, watched: watched.size, frozen: [...frozen.values()].filter(Boolean).length }),
  };
})();
