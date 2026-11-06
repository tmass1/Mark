// Renders the landing page's own pictures: the real editor on the charcoal the Mac app really shows,
// with the recording its video section plays, and two crops of the demo's desktop to draw on. A browser
// has no Mac material to show through the window's glass, and the stand-in for the Mac app below leaves its
// panes switched off, so here the material and the panes are put back. Needs the dev server and ffmpeg:
//   node scripts/site/render-landing.mjs [http://127.0.0.1:1420]
// ONLY=checkout, checkout-clean, board, board-video, signup, mockup or crops renders just that one.
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const examples = path.join(here, 'examples');
const out = path.join(here, '../../public/site');
const origin = process.argv[2] ?? 'http://127.0.0.1:1420';
const only = process.env.ONLY;
// The Mac's dark sidebar material. Under the window's --scrim it comes to #24272a,
// which is what a screenshot of the app measures. The floor and the panes are set the
// same way, to the #242a31 and #37393c measured there.
const MATERIAL = '#2a2a2a';
const MEASURED = ':root { --base: #242b34b8 !important; --panel: #dbe3f015 !important; }';

const browser = await chromium.launch();

async function save(png, name) {
  const { size } = await sharp(png).webp({ quality: 90 }).toFile(path.join(out, `${name}.webp`));
  console.log(`${name}.webp  ${Math.round(size / 1024)} KB`);
}

async function still(name, width, height, query = '') {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  await page.goto(`file://${examples}/${name}.html${query}`);
  await page.waitForTimeout(150);
  const png = await page.screenshot();
  await page.close();
  return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, width: width * 2, height: height * 2, scale: 2 };
}

/** The editor holding `capture`, through a stand-in for the Mac app. */
async function editorWith({ capture, view, request = null, frames = [] }) {
  const context = await browser.newContext({ viewport: view, deviceScaleFactor: 2, colorScheme: 'dark' });
  const page = await context.newPage();
  page.on('pageerror', e => console.log('pageerror', e.message));
  await page.addInitScript(state => {
    // Another session's edit must not reload the page halfway through a picture: no live reload here.
    const RealSocket = WebSocket;
    window.WebSocket = function (url, protocols) {
      return protocols === 'vite-hmr' ? { addEventListener() {}, close() {}, send() {}, readyState: 0 } : new RealSocket(url, protocols);
    };
    let next = 1;
    window.__TAURI_INTERNALS__ = {
      transformCallback: cb => { window[`__cb${++next}`] = cb; return next; }, unregisterCallback: () => {}, convertFileSrc: x => x,
      metadata: { currentWindow: { label: 'window' }, currentWebview: { windowLabel: 'window', label: 'window' } },
      async invoke(cmd) {
        if (cmd.startsWith('plugin:event|')) return next++;
        if (cmd === 'current_capture') return { capture: state.capture, error: null, busy: false, request: state.request };
        return state.returns[cmd];
      },
    };
  }, { capture, request, returns: { recording_supported: true, video_frames: frames, glass_available: false } });
  await page.goto(`${origin}/`);
  await page.addStyleTag({ content: `html, body { background: ${MATERIAL} !important; } ${MEASURED}` });
  await page.locator('.capture').waitFor();
  await page.waitForTimeout(500);
  const box = await page.locator('.overlay').boundingBox();
  const k = box.width / (capture.width / capture.scale);
  const on = (x, y) => [box.x + x * k, box.y + y * k];
  const drag = async (from, to) => {
    await page.mouse.move(...from); await page.mouse.down(); await page.mouse.move(...to, { steps: 10 }); await page.mouse.up();
  };
  const deselect = async () => { if (await page.locator('.handle, .note-outline').count()) await page.keyboard.press('Escape'); };
  const size = value => page.locator('.weight').evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, String(value));
  const numbered = async () => {
    await page.locator('.tool[data-slot="0"]').click({ button: 'right' });
    await page.locator('.tool-menu button', { hasText: 'Numbered arrow' }).click();
  };
  const note = async (from, to, text) => { await drag(on(...from), on(...to)); await page.keyboard.type(text); await page.keyboard.press('Escape'); };
  const framed = async () => {
    await page.getByRole('button', { name: /^Steps/ }).first().click(); await page.waitForTimeout(250);
    await page.getByRole('radio', { name: 'Framed', exact: true }).click();
    await page.locator('.steps-close').dispatchEvent('click');
  };
  const lights = () => page.evaluate(() => {
    const row = document.createElement('div');
    row.style.cssText = 'position:fixed;left:13px;top:15px;display:flex;gap:8px;z-index:99';
    for (const c of ['#ff5f57', '#febc2e', '#28c840']) {
      const d = document.createElement('span'); d.style.cssText = `width:12px;height:12px;border-radius:50%;background:${c}`; row.append(d);
    }
    document.body.append(row);
  });
  const rest = async () => { await page.mouse.move(5, view.height - 5); await page.waitForTimeout(400); };
  return { page, context, on, drag, deselect, size, numbered, note, framed, lights, rest };
}

if (!only || only === 'checkout') {
  const e = await editorWith({ capture: await still('checkout', 1100, 640), view: { width: 938, height: 616 } });
  await e.size(0.65); await e.numbered();
  await e.note([300, 466], [250, 503], 'Show the date, not the days');
  await e.note([290, 556], [592, 556], 'Make Express free over $75');
  await e.note([640, 612], [893, 566], 'Make Pay now full width');
  await e.deselect(); await e.framed(); await e.lights(); await e.rest();
  await save(await e.page.screenshot(), 'checkout');
  await e.context.close();
}

// The same window with nothing marked yet, for the page to draw the marks on as you scroll.
if (!only || only === 'checkout-clean') {
  const e = await editorWith({ capture: await still('checkout', 1100, 640), view: { width: 938, height: 616 } });
  await e.size(0.65); await e.numbered();
  await e.lights(); await e.rest();
  await save(await e.page.screenshot(), 'checkout-clean');
  await e.context.close();
}

if (!only || only === 'board') {
  const frames = [];
  for (let i = 0; i < 10; i++) frames.push((await still('board', 1100, 690, `?t=${(i / 9).toFixed(2)}`)).dataUrl);
  const capture = { ...await still('board', 1100, 690, '?t=0.55'), video: { id: 7, path: '/Recordings/7/Mark.mp4', duration: 14.2, sound: false } };
  const e = await editorWith({ capture, view: { width: 1200, height: 860 }, frames });
  await e.page.waitForSelector('.trim:not([hidden])'); await e.page.waitForTimeout(400);
  const strip = await e.page.locator('.strip').boundingBox();
  const seek = share => e.page.mouse.click(strip.x + strip.width * share, strip.y + 10);
  const edge = async (name, share) => {
    const h = await e.page.locator(`.edge[data-edge="${name}"]`).boundingBox();
    await e.page.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await e.page.mouse.down();
    await e.page.mouse.move(strip.x + strip.width * share, strip.y + 10, { steps: 5 }); await e.page.mouse.up();
  };
  await edge('start', 0.12); await edge('end', 0.9);
  await seek(0.4);
  await e.size(0.8); await e.numbered();
  await e.note([548, 560], [610, 352], 'Snaps back when dropped');
  await e.deselect();
  await seek(0.55);
  await e.page.keyboard.press('b');
  await e.drag(e.on(512, 276), e.on(732, 352));
  await e.deselect();
  await e.framed();
  await seek(0.5); await e.page.locator('.zoom-in').click();
  await seek(0.8); await e.page.locator('.cut-out').click();
  await seek(0.62);
  await e.lights(); await e.rest();
  // The page plays the recording in this window, so what moves is measured and left out:
  // the marks, the playhead, the times and the play button's icon.
  const box = selector => e.page.locator(selector).first().boundingBox();
  const stripBox = await box('.strip'), share = x => (x - stripBox.x) / stripBox.width;
  const [start, end, cut, zoom] = [await box('.edge[data-edge="start"]'), await box('.edge[data-edge="end"]'), await box('.cut'), await box('.zoom-band')];
  fs.writeFileSync(path.join(here, '../../src/site/board.json'), JSON.stringify({
    window: { width: 1200, height: 860 }, capture: await box('.overlay'), strip: stripBox, play: await box('.play'), times: await box('.times'),
    kept: [share(start.x), share(end.x + end.width)], cut: [share(cut.x), share(cut.x + cut.width)], zoom: [share(zoom.x), share(zoom.x + zoom.width)],
  }, null, 2));
  await e.page.addStyleTag({ content: '.overlay, .playhead, .now-time, .trim-time, .play svg { visibility: hidden !important; }' });
  await e.page.waitForTimeout(150);
  await save(await e.page.screenshot(), 'board-chrome');
  await e.context.close();
}

// The recording itself: the example's card, dragged, dropped, and snapping back. Times here are
// shares of its 14.2 seconds, matching the strip above.
if (!only || only === 'board-video') {
  const SECONDS = 14.2, FPS = 30, frames = Math.round(SECONDS * FPS);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mark-board-'));
  const page = await browser.newPage({ viewport: { width: 1100, height: 690 }, deviceScaleFactor: 2 });
  const at = s => (s < .2 ? 0 : s < .72 ? .8 * (s - .2) / .52 : s < .74 ? .85 : .9);
  let last = null, png = null;
  for (let i = 0; i < frames; i++) {
    const t = at(i / frames).toFixed(3);
    if (t !== last) {
      await page.goto(`file://${examples}/board.html?t=${t}`);
      png = await page.screenshot();
      last = t;
    }
    fs.writeFileSync(path.join(dir, `${String(i).padStart(4, '0')}.png`), png);
  }
  await page.close();
  const input = ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(dir, '%04d.png')];
  execFileSync('ffmpeg', [...input, '-vf', 'scale=1760:-2', '-c:v', 'libx264', '-crf', '30', '-preset', 'veryslow', '-g', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(out, 'board.mp4')]);
  execFileSync('ffmpeg', [...input, '-vf', 'scale=1760:-2', '-c:v', 'libvpx-vp9', '-crf', '42', '-b:v', '0', '-g', '30', '-row-mt', '1', '-cpu-used', '3', '-pix_fmt', 'yuv420p', path.join(out, 'board.webm')]);
  fs.rmSync(dir, { recursive: true });
  for (const name of ['board.mp4', 'board.webm']) console.log(name, `${Math.round(fs.statSync(path.join(out, name)).size / 1024)} KB`);
}

if (!only || only === 'signup') {
  const request = { id: 1, client: 'Codex', prompt: 'the sign-up error', mode: 'region', deadline: null };
  const e = await editorWith({ capture: await still('signup', 1100, 560), view: { width: 938, height: 564 }, request });
  await e.size(0.8); await e.numbered();
  await e.note([60, 400], [504, 408], '14 characters, still “too short”');
  await e.note([1040, 505], [992, 394], 'Yet it says Strong');
  await e.deselect(); await e.framed(); await e.lights(); await e.rest();
  await save(await e.page.screenshot(), 'signup');
  await e.context.close();
}

// The picture a phone gets in place of the demo: the demo's own dashboard, marked up.
if (!only || only === 'mockup') {
  const page = await browser.newPage({ viewport: { width: 1472, height: 960 }, deviceScaleFactor: 2 });
  await page.goto(`${origin}/demo.html`);
  await page.addStyleTag({ content: `.win.editor { background: ${MATERIAL} !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }` });
  const editor = page.frameLocator('.win.editor iframe');
  await editor.getByRole('heading', { name: 'Capture your screen' }).waitFor();
  await editor.locator('html').evaluate((el, css) => { el.ownerDocument.head.append(Object.assign(el.ownerDocument.createElement('style'), { textContent: css })); }, MEASURED);
  const stage = await page.locator('.stage').boundingBox();
  const at = (x, y) => ({ x: stage.x + x, y: stage.y + y });
  const region = { x: 400, y: 118, w: 860, h: 442 };
  const drag = async (from, to) => { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up(); };
  await editor.locator('[data-start="region"]').click();
  await page.frameLocator('.overlay').locator('.veil').waitFor();
  await drag(at(region.x, region.y), at(region.x + region.w, region.y + region.h));
  await page.frameLocator('.overlay').getByRole('button', { name: 'Capture', exact: true }).click();
  await editor.locator('.capture').waitFor();
  await page.waitForTimeout(300);
  const image = await editor.locator('.overlay').boundingBox();
  const k = image.width / region.w;
  const on = (x, y) => ({ x: image.x + (x - region.x) * k, y: image.y + (y - region.y) * k });
  await editor.locator('.tool[data-slot="0"]').click({ button: 'right' });
  await editor.locator('.tool-menu button', { hasText: 'Numbered arrow' }).click();
  await editor.locator('.weight').evaluate(el => { el.value = '0.8'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  for (const [from, to, note] of [
    [[700, 143], [1003, 143], 'Add an “All time” range'],
    [[600, 360], [936, 364], 'Show the day’s total on hover'],
    [[450, 520], [760, 468], 'Label the dashed line “Last year”'],
  ]) {
    await drag(on(...from), on(...to));
    await page.keyboard.type(note);
    await page.keyboard.press('Escape');
  }
  if (await editor.locator('.handle, .note-outline').count()) await page.keyboard.press('Escape');
  await editor.getByRole('button', { name: /^Steps/ }).first().click();
  await page.waitForTimeout(300);
  await editor.getByRole('radio', { name: 'Framed', exact: true }).click();
  await page.waitForTimeout(200);
  await editor.locator('.steps-close').click();
  await page.mouse.move(stage.x + 20, stage.y + 880);
  await page.waitForTimeout(400);
  await save(await page.screenshot({ clip: await page.locator('.win.editor').boundingBox() }), 'mockup');
  await page.close();
}

// The part of the Overview page in the editor's picture, and the Orders page to draw on: the demo's
// own desktop, so the marks on the page sit on the same dashboard the demo captures.
if (!only || only === 'crops') {
  const desktop = path.join(here, '../../public/demo');
  const crop = (from, name, extract) => sharp(path.join(desktop, from)).extract(extract).webp({ quality: 88 }).toFile(path.join(out, `${name}.webp`));
  await crop('scene.jpg', 'capture', { left: 799, top: 235, width: 1720, height: 884 });
  await crop('scene-orders.jpg', 'orders', { left: 779, top: 236, width: 1761, height: 1130 });
}

await browser.close();
