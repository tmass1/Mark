// Renders the site's pictures over made-up screens -- a checkout, a sprint
// board, a sign-up form, a trip on a phone and a tablet, a podcast player, a card of API keys -- so each
// section shows Mark on something different. Each screen in examples/ is drawn
// to a PNG, handed to the real editor at / as its capture through a stand-in
// for the Mac app, and marked up there by hand. Needs the dev server (pnpm dev), then:
//   node scripts/site/render-examples.mjs [http://127.0.0.1:1420]
// ONLY=checkout (or board, signup, phone, browser, tablet, player, keys) renders just that picture.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '../../public/site');
const origin = process.argv[2] ?? 'http://127.0.0.1:1420';
const only = process.env.ONLY;
fs.mkdirSync(out, { recursive: true });
// A browser has no Mac material behind the window's glass, so it's put there: the dark
// one that comes to #24272a under the window's --scrim, as a screenshot of the app
// measures. The floor and the panes are set to the #242a31 and #37393c measured there
// too. render-shots.mjs uses the same values.
const MATERIAL = '#2a2a2a';
const MEASURED = ':root { --base: #242b34b8 !important; --panel: #dbe3f015 !important; }';

const browser = await chromium.launch();

/** An example screen, drawn at 2x, as a capture; `query` is the board's point in its drag. */
async function still(name, width, height, query = '') {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  await page.goto(`file://${here}/examples/${name}.html${query}`);
  await page.waitForTimeout(150);
  const png = await page.screenshot();
  await page.close();
  return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, width: width * 2, height: height * 2, scale: 2 };
}

/** A picture of `target`, scaled down to `width` pixels if given. */
async function shot(target, name, { width, ...options } = {}) {
  const file = path.join(out, `${name}.png`);
  await target.screenshot({ path: file, ...options });
  if (width) execFileSync('sips', ['--resampleWidth', String(width), file, '--out', file], { stdio: 'ignore' });
  console.log(`${name}.png  ${Math.round(fs.statSync(file).size / 1024)} KB`);
}

/** The editor holding `capture`, in a window of `view`, with an AI tool's ask waiting if given. */
async function editorWith({ capture, view, request = null, frames = [] }) {
  const context = await browser.newContext({ viewport: view, deviceScaleFactor: 2, colorScheme: 'dark' });
  const page = await context.newPage();
  page.on('pageerror', e => console.log('pageerror', e.message));
  // What the Mac app would answer: this capture, the ask, and a recording's frames. And no
  // native glass, said outright: an undefined answer would turn native-glass on in main.ts,
  // and that switches off the panes the toolbar and the rail are drawn on.
  await page.addInitScript(state => {
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
  const k = box.width / (capture.width / capture.scale);   // screen px per point of the example
  const on = (x, y) => [box.x + x * k, box.y + y * k];
  const drag = async (from, to) => {
    await page.mouse.move(...from); await page.mouse.down(); await page.mouse.move(...to, { steps: 10 }); await page.mouse.up();
  };
  // A fresh annotation stays selected; Escape with nothing selected would close the editor.
  const deselect = async () => { if (await page.locator('.handle, .note-outline').count()) await page.keyboard.press('Escape'); };
  const tool = name => page.getByRole('radio', { name, exact: true }).click();
  // The size slider is a range input; Playwright cannot fill one, so set it the way a drag would.
  const size = value => page.locator('.weight').evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, String(value));
  // The arrow slot's numbered way, from its menu, as a right-click offers it.
  const numbered = async () => {
    await page.locator('.tool[data-slot="0"]').click({ button: 'right' });
    await page.locator('.tool-menu button', { hasText: 'Numbered arrow' }).click();
  };
  const note = async (from, to, text) => { await drag(on(...from), on(...to)); await page.keyboard.type(text); await page.keyboard.press('Escape'); };
  // The notes written on the picture beside their badges, and the list put away.
  // The request bar overlaps the list's close button, so it is clicked directly.
  const framed = async () => {
    await page.getByRole('button', { name: /^Steps/ }).first().click(); await page.waitForTimeout(250);
    await page.getByRole('radio', { name: 'Framed', exact: true }).click();
    await page.locator('.steps-close').dispatchEvent('click');
  };
  // The window's lights, which the Mac draws and a page doesn't.
  const lights = () => page.evaluate(() => {
    const row = document.createElement('div');
    row.style.cssText = 'position:fixed;left:13px;top:15px;display:flex;gap:8px;z-index:99';
    for (const c of ['#ff5f57', '#febc2e', '#28c840']) {
      const d = document.createElement('span'); d.style.cssText = `width:12px;height:12px;border-radius:50%;background:${c}`; row.append(d);
    }
    document.body.append(row);
  });
  const rest = async () => { await page.mouse.move(5, view.height - 5); await page.waitForTimeout(400); };
  return { page, context, on, drag, deselect, tool, size, numbered, note, framed, lights, rest, k };
}

// How it works: a checkout, mocked up with three changes, the notes on the picture.
if (!only || only === 'checkout') {
  const e = await editorWith({ capture: await still('checkout', 1100, 640), view: { width: 938, height: 616 } });
  await e.size(0.65); await e.numbered();
  await e.note([300, 466], [250, 503], 'Show the date, not the days');
  await e.note([290, 556], [592, 556], 'Make Express free over $75');
  await e.note([640, 612], [893, 566], 'Make Pay now full width');
  await e.deselect(); await e.framed(); await e.lights(); await e.rest();
  await shot(e.page, 'checkout');
  await e.context.close();
}

// Video: a recording of a sprint board, trimmed, zoomed where the card is dragged and with
// a part cut out, a note and a box where the card snaps back. Wide enough to name its tools.
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
  await shot(e.page, 'board');
  await e.context.close();
}

// Agents: Codex asks to see the sign-up error; two numbered arrows say what's wrong.
if (!only || only === 'signup') {
  const request = { id: 1, client: 'Codex', prompt: 'the sign-up error', mode: 'region', deadline: null };
  const e = await editorWith({ capture: await still('signup', 1100, 560), view: { width: 938, height: 564 }, request });
  await e.size(0.8); await e.numbered();
  await e.note([60, 400], [504, 408], '14 characters, still “too short”');
  await e.note([1040, 505], [992, 394], 'Yet it says Strong');
  await e.deselect(); await e.framed(); await e.lights(); await e.rest();
  await shot(e.page, 'signup');
  await e.context.close();
}

// Frame: each device round a screen of its own, on one of the app's backgrounds, from the
// panel a visitor would use. What goes on the page is the frame itself, not the editor round it.
async function inFrame(e, name, { background, device, colour, island, padding, width }) {
  await e.page.getByRole('button', { name: 'Frame', exact: true }).click();
  const panel = e.page.locator('.frame-panel');
  await panel.waitFor({ state: 'visible' });
  await panel.getByRole('radio', { name: background, exact: true }).click();
  await panel.locator('.devices').getByRole('radio', { name: device, exact: true }).click();
  if (colour) await panel.locator('.colours').getByRole('radio', { name: colour, exact: true }).click();
  if (island) await panel.getByRole('checkbox', { name: 'Dynamic Island' }).check();
  if (padding !== undefined) await panel.locator('[data-frame="padding"]').evaluate((el, v) => {
    el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(padding));
  await e.page.keyboard.press('Escape');                // the panel goes; the frame stays
  await panel.waitFor({ state: 'hidden' });
  await e.rest();
  await shot(e.page.locator('.backdrop'), name, { width });
  await e.context.close();
}

// A phone, with its island: Waypoint's itinerary, and one change to make.
if (!only || only === 'phone') {
  const e = await editorWith({ capture: await still('trip-phone', 390, 844), view: { width: 900, height: 1180 } });
  await e.size(0.6); await e.numbered();
  await e.note([74, 712], [208, 628], 'Say who booked it');
  await e.deselect(); await e.framed();
  await inFrame(e, 'phone', { background: 'Dusk', device: 'Phone', colour: 'Natural Titanium', island: true, width: 900 });
}

// A browser: the checkout, and one change to make.
if (!only || only === 'browser') {
  const e = await editorWith({ capture: await still('checkout', 1100, 640), view: { width: 1400, height: 1000 } });
  await e.size(0.65); await e.numbered();
  await e.note([640, 612], [893, 566], 'Make Pay now full width');
  await e.deselect(); await e.framed();
  await inFrame(e, 'browser', { background: 'Aurora', device: 'Browser', width: 1200 });
}

// A tablet: Waypoint's map, in Deep Blue.
if (!only || only === 'tablet') {
  const e = await editorWith({ capture: await still('trip-tablet', 1100, 780), view: { width: 1500, height: 1280 } });
  await e.size(0.8); await e.numbered();
  await e.note([520, 600], [666, 364], 'Say how long the tram takes');
  await e.deselect(); await e.framed();
  await inFrame(e, 'tablet', { background: 'Peach', device: 'Tablet', colour: 'Deep Blue', width: 1000 });
}

// A window: a podcast player, an arrow and a word on it.
if (!only || only === 'player') {
  const e = await editorWith({ capture: await still('player', 980, 640), view: { width: 1300, height: 1040 } });
  await e.size(0.9); await e.tool('Arrow');
  await e.drag(e.on(336, 357), e.on(250, 395)); await e.deselect();
  await e.tool('Text'); await e.page.mouse.click(...e.on(342, 339));
  await e.page.keyboard.type('Thicker, with chapters'); await e.page.keyboard.press('Escape'); await e.deselect();
  await inFrame(e, 'window', { background: 'Lagoon', device: 'Window', width: 1000 });
}

// Features: the live API key redacted, the test key beside it left alone.
if (!only || only === 'keys') {
  const e = await editorWith({ capture: await still('keys', 760, 300), view: { width: 1200, height: 700 } });
  await e.tool('Redact');
  await e.drag(e.on(180, 113), e.on(590, 145)); await e.deselect();
  await e.rest();
  const [x, y] = e.on(34, 92);
  await shot(e.page, 'redacted', { clip: { x, y, width: 340 * e.k, height: 170 * e.k } });
  await e.context.close();
}

await browser.close();
