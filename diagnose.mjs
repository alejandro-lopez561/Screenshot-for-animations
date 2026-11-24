#!/usr/bin/env node
/**
 * diagnose.mjs — find out how one block of a page animates, so a capture
 * problem can be fixed precisely.
 *
 *   node diagnose.mjs <url> "<text inside the block>" [--profile dir] [--channel chrome]
 *
 * Example:
 *   node diagnose.mjs https://site/page "Can RINVOQ help stop joint damage"
 *
 * It scrolls the block into view, photographs it at 0, 2, 5, 10 and 15 s, and
 * records every element inside it (tag, classes, size, opacity, transform,
 * background image, video/canvas/svg/lottie details, running animations).
 * Output goes to ./diagnose-out/: send that folder back.
 */
import { chromium } from 'playwright';
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: { profile: { type: 'string' }, channel: { type: 'string' }, out: { type: 'string', default: 'diagnose-out' } },
});
if (positionals.length !== 2) {
  console.log('Usage: node diagnose.mjs <url> "<text inside the block>" [--profile dir] [--channel chrome]');
  process.exit(1);
}
const [url, text] = positionals;
const OUT = path.resolve(opt.out);
fs.mkdirSync(OUT, { recursive: true });

const ctxOpts = { viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' };
let browser, context;
if (opt.profile) {
  context = await chromium.launchPersistentContext(path.resolve(opt.profile), { ...ctxOpts, headless: false, channel: opt.channel });
} else {
  browser = await chromium.launch({ headless: false, channel: opt.channel });
  context = await browser.newContext(ctxOpts);
}
const page = context.pages()[0] ?? await context.newPage();

try {
  await page.goto(url, { waitUntil: 'load', timeout: 10000 });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

  // Find the smallest "block" containing the text: walk up to a reasonably sized box.
  const found = await page.evaluate((t) => {
    const leaf = [...document.querySelectorAll('body *')].find((e) =>
      e.children.length === 0 && e.textContent.includes(t)) ||
      [...document.querySelectorAll('body *')].reverse().find((e) => e.textContent.includes(t));
    if (!leaf) return null;
    let el = leaf;
    while (el.parentElement && el.getBoundingClientRect().height < 250) el = el.parentElement;
    // go one more level up so siblings (e.g. the 3 cards) are included
    const block = el.parentElement || el;
    block.setAttribute('data-diag-block', '');
    const r = block.getBoundingClientRect();
    return { tag: block.tagName, cls: block.className?.toString(), top: r.top + scrollY, h: r.height };
  }, text);
  if (!found) throw new Error(`Text not found on page: "${text}"`);
  console.log('Block:', found);

  // Scroll it into view the way a user would arrive at it (from above).
  await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 900)), found.top);
  await page.waitForTimeout(800);
  await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 150)), found.top);

  const block = page.locator('[data-diag-block]');
  const snaps = [];
  let last = 0;
  for (const t of [0, 2, 5, 10, 15]) {
    await page.waitForTimeout((t - last) * 1000);
    last = t;
    await block.screenshot({ path: path.join(OUT, `block-${String(t).padStart(2, '0')}s.png`) }).catch(() => {});
    snaps.push({ t, elements: await page.evaluate(() => {
      const root = document.querySelector('[data-diag-block]');
      return [root, ...root.querySelectorAll('*')].slice(0, 400).map((e) => {
        const cs = getComputedStyle(e), r = e.getBoundingClientRect();
        const o = {
          tag: e.tagName.toLowerCase(), id: e.id || undefined,
          cls: (e.getAttribute('class') || '').slice(0, 120) || undefined,
          box: `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`,
          display: cs.display !== 'block' ? cs.display : undefined,
          opacity: cs.opacity !== '1' ? cs.opacity : undefined,
          visibility: cs.visibility !== 'visible' ? cs.visibility : undefined,
          transform: cs.transform !== 'none' ? cs.transform : undefined,
          clip: cs.clipPath !== 'none' ? cs.clipPath : undefined,
          overflow: cs.overflow !== 'visible' ? cs.overflow : undefined,
          bg: cs.backgroundImage !== 'none' ? cs.backgroundImage.slice(0, 160) : undefined,
          transition: cs.transitionDuration !== '0s' ? `${cs.transitionProperty} ${cs.transitionDuration}` : undefined,
          anims: e.getAnimations?.().map((a) => `${a.constructor.name}:${a.animationName || a.transitionProperty || ''}:${a.playState}`).join(', ') || undefined,
          attrs: [...e.attributes].filter((a) => /^(data-|aria-hidden|src|srcset|poster|loading)/.test(a.name))
            .map((a) => `${a.name}=${a.value.slice(0, 100)}`).join(' ') || undefined,
          text: e.children.length === 0 ? e.textContent.trim().slice(0, 60) || undefined : undefined,
        };
        if (e.tagName === 'VIDEO') Object.assign(o, { video: { src: e.currentSrc, readyState: e.readyState, paused: e.paused, ended: e.ended, t: e.currentTime, dur: e.duration, loop: e.loop, error: e.error?.code } });
        if (e.tagName === 'IMG') Object.assign(o, { img: { src: e.currentSrc, complete: e.complete, natural: `${e.naturalWidth}x${e.naturalHeight}` } });
        if (e.tagName === 'CANVAS') Object.assign(o, { canvas: `${e.width}x${e.height}` });
        if (e.tagName === 'IFRAME') Object.assign(o, { iframe: e.src });
        return JSON.parse(JSON.stringify(o));
      });
    }) });
  }
  const libs = await page.evaluate(() => ({
    jquery: window.jQuery?.fn?.jquery, gsap: window.gsap?.version, ScrollTrigger: !!window.ScrollTrigger,
    lottie: !!(window.lottie || window.bodymovin), AOS: !!window.AOS, swiper: !!window.Swiper,
    lottiePlayers: document.querySelectorAll('lottie-player,dotlottie-player').length,
  }));
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ url, text, block: found, libs, snaps }, null, 1));
  fs.writeFileSync(path.join(OUT, 'block.html'),
    await page.evaluate(() => document.querySelector('[data-diag-block]').outerHTML));
  console.log(`Done. Send the folder ${OUT} (report.json, block.html, block-XXs.png).`);
} finally {
  await context.close();
  if (browser) await browser.close();
}
