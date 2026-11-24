# Full-page PDF and PNG screenshots

This tool produces one PDF (or PNG) of an entire web page in which every scroll-triggered animation is shown in its finished state. It works even on pages where animations run only while their section is in the viewport and reset when you scroll away.

## Quick start

```bash
npm install
npx playwright install chromium     # one-time

node capture.mjs https://your-site.com/page --out page.pdf
```

The tool then:
1. Scrolls through the page half a screen at a time. Every element stays on screen for at least 10 s before it is locked in its final state.
2. Saves `page.pdf` (a single page, lossless) and keeps `page.png` next to it.

**Pages behind a login:** add `--profile ./browser-profile`. On the first run, sign in inside the capture window; later runs reuse that login.



## Options

```
Output
  --out <file>           .pdf (single page) or .png        (screenshot.pdf)
  --mode latch|stitch    Capture strategy                  (latch)
Timing
  --wait <ms>            Minimum time every element is on screen before it is
                         frozen / captured                 (10000)
  --extra-wait <ms>      Extra time per step if something is still moving (5000)
  --step <fraction>      Scroll step, fraction of viewport height (0.5)
  --line <fraction>      Freeze once an element's top passes this fraction (0.5)
Browser
  --profile <dir>        Persistent browser profile (log in once, reuse it)
  --channel chrome       Use installed Google Chrome (needed for MP4 animations)
  --headless             No visible browser window
Page
  --width/--height <px>  Viewport                          (1440 x 900)
  --dpr <n>              Device pixel ratio, 2 = retina    (1)
  --hide <css>           Hide elements (cookie banners, chat). Repeatable.
  --click <css>          Click after load (e.g. Accept cookies). Repeatable.
  --unfix <css>          Make fixed/sticky elements static before capture
  --debug-tiles <dir>    Save the viewport at every step
```

Examples:

```bash
# Retina PDF, cookie banner accepted, a little extra time per animation
node capture.mjs https://site.com/page --out page.pdf --dpr 2 --click "#onetrust-accept-btn-handler" --wait 11000

# Page behind a login, with MP4 animated icons
node capture.mjs https://site.com/page --profile ./browser-profile --channel chrome

# Canvas/WebGL-heavy page
node capture.mjs https://site.com/page --mode stitch --out page.pdf

# Capture a screenshot saving passwords 
node capture.mjs https://site.com/page --out screenshot-name.png  --wait 5000 --width 1200 --profile ./browser-profile --login

node capture.mjs https://site.com/page --out screenshot-name.pdf  --wait 5000 --width 1200 --profile ./browser-profile --login

node capture.mjs https://site.com/page --out screenshot-name.pdf  --wait 5000 --width 375 --profile ./browser-profile --login
```

**Run time:** about `--wait` per half-screen step. A page 10 screens tall takes about 3–4 minutes at the default 10 s. This is deliberate: every animation gets its full time.


## Troubleshooting

| Symptom | Fix |
|---|---|
| A section is still mid-animation | Increase `--wait`, for example `--wait 12000` |
| The log says "still moving" for some steps | A carousel, looping video or long animation is on screen. If that area looks unfinished, raise `--extra-wait` |
| An element is frozen in its *start* state | Its trigger fires late (for example "top 30%"). Use `--line 0.3` |
| The login page appears in the capture | Use `--profile ./browser-profile` and sign in once in the capture window |
| Empty boxes where icons or videos should be | If the log shows a video `WARNING`, add `--channel chrome`. Otherwise run `diagnose.mjs` on that block |
| A floating bar is printed across the page | Fixed automatically. If one is missed, add `--hide "<its selector>"` |
| Cookie bar or chat bubble appears in the image | `--hide ".cookie-banner" --hide "#chat-widget"` |
| Header appears twice | `--unfix "header"` |
