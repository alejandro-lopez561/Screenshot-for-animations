#!/usr/bin/env node
/**
 * capture.mjs — full-page screenshot (PDF or PNG) with every scroll-triggered
 * animation captured in its completed state.
 *
 *   node capture.mjs <url> [options]
 *
 * Run with --help for all options.
 */
import { chromium } from 'playwright';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { stitch, concatVertical } from './lib/stitch.mjs';
import { pngToPdf } from './lib/pdf.mjs';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LATCH = path.join(HERE, 'lib', 'latch.js');

const HELP = `
Usage: node capture.mjs <url> [options]

Output
  --out <file>           .pdf (single page) or .png        (default: screenshot.pdf)
                         A .png with the same name is kept next to a PDF.
  --mode latch|stitch    Capture strategy                  (default: latch)

Timing
  --wait <ms>            Minimum time every element stays on screen before it
                         is frozen / captured              (default: 10000)
  --extra-wait <ms>      Extra time allowed per step for animations that are
                         still moving after --wait          (default: 5000)
  --step <fraction>      Scroll step, fraction of viewport height (default: 0.5)
  --line <fraction>      Freeze elements once their top passes this fraction of
                         the viewport height (latch mode)   (default: 0.5)

Browser
  --profile <dir>        Persistent browser profile (log in once, reuse it)
  --channel <name>       Use installed Chrome instead of bundled Chromium,
                         e.g. "chrome" (needed for MP4 animations)
  --login                Open the page, let you sign in / enter passwords (e.g.
                         a Ceros password box), then press Enter to capture.
                         Combine with --profile so it is remembered.
  --headless             No visible browser window

Page
  --width <px> --height <px>  Viewport                      (default: 1440x900)
  --dpr <n>              Device scale factor, 2 = retina    (default: 1)
  --hide <css>           Hide elements (cookie banners, chat). Repeatable.
  --click <css>          Click after load (e.g. "Accept cookies"). Repeatable.
  --unfix <css>          Make fixed/sticky elements static before capture
  --keep-fixed           Don't hide floating fixed bars/buttons (by default
                         they are hidden so they aren't stamped mid-page)
  --skip-frames          Don't photograph embedded iframes (Ceros, videos...)
                         separately; by default each is captured on screen,
                         after --wait, and pasted into the final image
  --debug-tiles <dir>    Save the viewport at every step
  -h, --help
`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: 'screenshot.pdf' },
    mode: { type: 'string', default: 'latch' },
    wait: { type: 'string', default: '10000' },
    'extra-wait': { type: 'string', default: '5000' },
    step: { type: 'string', default: '0.5' },
    line: { type: 'string', default: '0.5' },
    width: { type: 'string', default: '1440' },
    height: { type: 'string', default: '900' },
    dpr: { type: 'string', default: '1' },
    hide: { type: 'string', multiple: true, default: [] },
    click: { type: 'string', multiple: true, default: [] },
    unfix: { type: 'string', multiple: true, default: [] },
    headless: { type: 'boolean', default: false },
    profile: { type: 'string' },
    channel: { type: 'string' },
    'debug-tiles': { type: 'string' },
    'keep-fixed': { type: 'boolean', default: false },
    'skip-frames': { type: 'boolean', default: false },
    login: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (opt.help || positionals.length !== 1) {
  console.log(HELP);
  process.exit(opt.help ? 0 : 1);
}
if (!['latch', 'stitch'].includes(opt.mode)) {
  console.error(`--mode must be "latch" or "stitch", got "${opt.mode}"`);
  process.exit(1);
}

const url = positionals[0];
const WAIT = Number(opt.wait);
const EXTRA = Number(opt['extra-wait']);
const STEP = Number(opt.step);
const LINE = opt.mode === 'latch' ? Number(opt.line) : 0.75; // stitch: centre band of each tile
const VW = Number(opt.width);
const VH = Number(opt.height);
const DPR = Number(opt.dpr);
const MAX_SHOT_PX = 15000; // Chromium textures get unreliable above ~16k px
const OUT = path.resolve(opt.out);
const WANT_PDF = /\.pdf$/i.test(OUT);
const PNG_OUT = WANT_PDF ? OUT.replace(/\.pdf$/i, '.png') : OUT;

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

/* ---------- browser ---------- */
const launchArgs = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--hide-scrollbars',
];
const ctxOptions = {
  viewport: { width: VW, height: VH },
  deviceScaleFactor: DPR,
  reducedMotion: 'no-preference', // some sites skip animations entirely on "reduce"
};
// Bundled Chromium can't play MP4/H.264; pass --channel chrome for MP4 animations.
const channel = opt.channel;

let browser, context;
if (opt.profile) {
  context = await chromium.launchPersistentContext(path.resolve(opt.profile), {
    ...ctxOptions, headless: opt.headless, channel, args: launchArgs,
  });
} else {
  browser = await chromium.launch({ headless: opt.headless, channel, args: launchArgs });
  context = await browser.newContext(ctxOptions);
}
await context.addInitScript({ path: LATCH });

const page = context.pages()[0] ?? await context.newPage();

try {
  await run();
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await context.close();
  if (browser) await browser.close();
}

/* ---------- helpers ---------- */
function viewportShot() {
  return page.screenshot({ scale: 'css', animations: 'allow', caret: 'initial', timeout: 5000 });
}

function changedPixels(a, b) {
  const A = PNG.sync.read(a), B = PNG.sync.read(b);
  if (A.width !== B.width || A.height !== B.height) return Infinity;
  return pixelmatch(A.data, B.data, null, A.width, A.height, { threshold: 0.05 });
}

/**
 * After the time gate, keep waiting while anything still moves on screen,
 * up to `maxMs`. Counts changed pixels, not a percentage, so a thin line
 * being drawn or a small icon animating still counts as "moving".
 */
async function settle(maxMs) {
  const t0 = Date.now();
  await page.evaluate(() => window.__latch.pauseLoops());
  let prev = await viewportShot();
  let stable = 0;
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(400);
    const cur = await viewportShot();
    const moving = changedPixels(prev, cur) > 20 ||
      await page.evaluate(() => window.__latch.finiteRunningInView());
    prev = cur;
    stable = moving ? 0 : stable + 1;
    if (stable >= 3) return { ms: Date.now() - t0, settled: true };
  }
  return { ms: Date.now() - t0, settled: false };
}

async function waitForImagesInView(timeout = 5000) {
  await page.waitForFunction(() => window.__latch.imagesInViewReady(), null, { timeout }).catch(() => {});
}

/**
 * Embedded iframes (Ceros etc.) run their own animations in another document,
 * and often blank out or restart once off screen, so the final full-page shot
 * can't be trusted for them. Bring each one to the middle of the screen, give
 * it the full --wait plus the settle check, and photograph it there.
 * Returns Map(frameIndex -> { src, buf }).
 */
async function captureFrames() {
  const shots = new Map();
  const list = await page.evaluate(() => window.__latch.framesInfo());
  if (!list.length) return shots;
  log(`Embedded iframes: ${list.length} (${list.map((f) => f.src).join(', ')}). Photographing each on screen...`);
  for (const f of list) {
    if (shots.has(f.i)) continue;
    const target = Math.max(0, Math.round(f.pageY - (VH - f.h) / 2));
    await page.evaluate((t) => window.scrollTo(0, t), target);
    await page.waitForTimeout(350);
    await waitForImagesInView();
    await page.waitForTimeout(WAIT);
    const s = await settle(EXTRA);
    const got = [];
    for (const g of await page.evaluate(() => window.__latch.framesInfo())) {
      if (shots.has(g.i) || !g.full || g.occluded) continue;
      shots.set(g.i, {
        src: g.src,
        buf: await page.screenshot({ clip: { x: g.x, y: g.y, width: g.w, height: g.h }, animations: 'allow', caret: 'initial' }),
      });
      got.push(g.src);
    }
    if (got.length) log(`  captured ${got.join(', ')}${s.settled ? '' : ' (was still moving)'}`);
    if (!shots.has(f.i)) log(`  WARNING: no clear view of ${f.src} (covered or larger than the screen); left as rendered`);
  }
  return shots;
}

/** Paste the on-screen iframe photos over their spots in the full-page image. */
async function pasteFrames(shots, file) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const pos = await page.evaluate(() => window.__latch.framesInfo());
  const img = sharp(file, { limitInputPixels: false });
  const { width, height } = await img.metadata();
  const comps = [];
  for (const p of pos) {
    const s = shots.get(p.i);
    if (!s) continue;
    const left = Math.round(p.pageX * DPR), top = Math.round(p.pageY * DPR);
    const m = await sharp(s.buf).metadata();
    if (left < 0 || top < 0 || left + m.width > width || top + m.height > height) continue;
    comps.push({ input: s.buf, left, top });
  }
  const buf = await img.composite(comps).png().toBuffer();
  fs.writeFileSync(file, buf);
  log(`Pasted ${comps.length} on-screen iframe capture(s) into the page image`);
}

function pageHeight() {
  return page.evaluate(() =>
    Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
}

/* ---------- main ---------- */
async function run() {
  log(`Opening ${url}  (mode=${opt.mode}, viewport=${VW}x${VH}@${DPR}x, wait=${WAIT}ms)`);
  await page.goto(url, { waitUntil: 'load', timeout: 10000 });
  if (opt.login) {
    if (opt.headless) throw new Error('--login needs a visible window; remove --headless');
    log('Sign in / enter any passwords in the browser window (scroll down to unlock every embed).');
    log('When the page looks right, come back here and press Enter to start the capture...');
    await new Promise((r) => { process.stdin.resume(); process.stdin.once('data', () => { process.stdin.pause(); r(); }); });
    await page.goto(url, { waitUntil: 'load', timeout: 10000 }); // fresh load so every animation starts from scratch
  }
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => log('networkidle timed out; continuing'));
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.addStyleTag({ content: 'html,body{scroll-behavior:auto!important}' });

  if (page.url() !== url) log(`Landed on ${page.url()}`);

  for (const sel of opt.click) {
    await page.locator(sel).first().click({ timeout: 5000 }).then(() => log(`clicked ${sel}`))
      .catch(() => log(`could not click ${sel} (not found?)`));
  }
  if (opt.hide.length) await page.evaluate((s) => window.__latch.hide(s), opt.hide);
  await page.evaluate(() => window.__latch.markVisible());

  if (opt['debug-tiles']) fs.mkdirSync(opt['debug-tiles'], { recursive: true });

  const tiles = [];
  const notSettled = [];
  let y = 0;
  for (let i = 0; ; i++) {
    const max = (await pageHeight()) - VH;
    const target = Math.max(0, Math.min(Math.round(y), max));
    await page.evaluate((t) => window.scrollTo(0, t), target);
    await page.waitForTimeout(350); // let observers / scroll handlers fire
    await page.evaluate(() => window.__latch.markVisible());
    await waitForImagesInView();
    const isLast = target >= max;

    // Time gate: every element about to be frozen/captured has been on screen >= WAIT.
    const t0 = Date.now();
    const need = await page.evaluate((o) => window.__latch.pendingWait(o), { wait: WAIT, line: LINE, all: isLast });
    if (need > 0) await page.waitForTimeout(need);
    const s = await settle(EXTRA);
    if (!s.settled) notSettled.push(i);
    const actualY = await page.evaluate(() => window.scrollY);

    let frozenNow = 0;
    if (opt.mode === 'latch') {
      frozenNow = await page.evaluate(({ line, all, wait }) =>
        window.__latch.freezeLibraries({ line, all }) + window.__latch.freezeInView({ line, all, wait }),
      { line: LINE, all: isLast, wait: WAIT });
    } else {
      if (i === 1) await page.evaluate(() => { // fixed headers/widgets: keep them only in tile 0
        for (const el of window.__latch.fixedElements()) {
          if (getComputedStyle(el).position === 'fixed') el.style.setProperty('visibility', 'hidden', 'important');
        }
      });
      tiles.push({ buf: await page.screenshot({ animations: 'allow', caret: 'initial' }), scrollY: actualY });
    }
    if (opt['debug-tiles']) {
      await page.screenshot({ path: path.join(opt['debug-tiles'], `step-${String(i).padStart(3, '0')}.png`) });
    }
    log(`step ${i}: y=${actualY}/${max}  waited=${((Date.now() - t0) / 1000).toFixed(1)}s` +
      `${s.settled ? '' : ' (still moving)'}  frozen=${frozenNow}`);
    if (isLast) break;
    y = target + VH * STEP;
  }
  const broken = await page.evaluate(() => window.__latch.brokenVideos());
  if (broken.length) {
    log(`WARNING: ${broken.length} video(s) could not play in this browser (${broken.slice(0, 5).join(', ')}). ` +
      (opt.channel ? '' : 'Bundled Chromium has no MP4/H.264 support, so these animated icons will be ' +
        'blank boxes. Re-run with --channel chrome to fix it.'));
  }
  if (notSettled.length) {
    log(`Note: steps ${notSettled.join(', ')} still had motion after --extra-wait (looping animation, ` +
      'carousel or video?). Increase --extra-wait if something there looks unfinished.');
  }

  // Floating bars must go before photographing iframes, so they don't cover them.
  if (!opt['keep-fixed']) await page.evaluate(() => window.__latch.hideFloating());
  const frameShots = opt['skip-frames'] ? new Map() : await captureFrames();

  const H = await pageHeight();
  const title = await page.title();
  if (opt.mode === 'stitch') {
    const res = await stitch(tiles, { viewportHeight: VH, pageHeight: H, width: VW, dpr: DPR }, PNG_OUT);
    log(`Stitched ${res.tiles} tiles (${res.width}x${res.height})`);
  } else {
    // Everything is locked: take one native full-page shot.
    await page.evaluate((u) => { window.__latch.pauseAll(); window.__latch.unfix(u); }, opt.unfix);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    if (!opt['keep-fixed']) {
      // Floating bars (safety drawer, back-to-top, chat) would be stamped across the page.
      const hidden = await page.evaluate(() => window.__latch.hideFloating());
      if (hidden.length) log(`Hid ${hidden.length} floating element(s): ${hidden.join('; ')}  (--keep-fixed to keep)`);
    }
    const st = await page.evaluate(() => window.__latch.stats());
    log(`Locked ${st.frozen} elements; guard blocked ${st.guardRestores} reset attempts`);

    if (H * DPR <= MAX_SHOT_PX) {
      await page.screenshot({ path: PNG_OUT, fullPage: true, animations: 'disabled', caret: 'initial' });
    } else {
      const seg = Math.floor(MAX_SHOT_PX / DPR / 2);
      const bufs = [];
      for (let top = 0; top < H; top += seg) {
        bufs.push(await page.screenshot({
          fullPage: true, animations: 'disabled', caret: 'initial',
          clip: { x: 0, y: top, width: VW, height: Math.min(seg, H - top) },
        }));
      }
      await concatVertical(bufs, Math.round(VW * DPR), PNG_OUT);
    }
  }
  if (frameShots.size) await pasteFrames(frameShots, PNG_OUT);

  if (WANT_PDF) {
    const r = await pngToPdf(PNG_OUT, OUT, { dpr: DPR, title, url });
    log(`Saved ${OUT}  (1 page, ${r.widthPt}x${r.heightPt} pt${r.scaled ? ', scaled to fit PDF limits' : ''})`);
    log(`PNG kept at ${PNG_OUT}`);
  } else {
    log(`Saved ${PNG_OUT}`);
  }
}
