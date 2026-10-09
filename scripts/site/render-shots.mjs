// Renders the site's pictures of Mark from the web demo, so every picture is the
// real editor, overlay and settings rather than a mockup, and re-rendering after
// a design change is one command. Needs the dev server (pnpm dev), then:
//   node scripts/site/render-shots.mjs [http://127.0.0.1:1420]
// ONLY=ask renders just the picture of Claude asking, leaving the rest as they are.
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '../../public/site');
const origin = process.argv[2] ?? 'http://127.0.0.1:1420';
const only = process.env.ONLY;
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
// Wide enough that the stage is laid out at 1440 and not scaled: one stage
// point per scene point, so the numbers below are scene coordinates.
const page = await browser.newPage({ viewport: { width: 1472, height: 960 }, deviceScaleFactor: 2 });
await page.goto(`${origin}/demo.html`);
const editor = page.frameLocator('.win.editor iframe');
await editor.getByRole('heading', { name: 'Capture your screen' }).waitFor();
const stage = await page.locator('.stage').boundingBox();
const at = (x, y) => ({ x: stage.x + x, y: stage.y + y });

async function drag(from, to, release = true) {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  if (release) await page.mouse.up();
}
async function shot(name, clip, type = 'png') {
  const file = path.join(out, `${name}.${type}`);
  await page.screenshot({ path: file, type, ...(type === 'jpeg' ? { quality: 90 } : {}), clip });
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(`${name}.${type}  ${Math.round(clip.width * 2)} x ${Math.round(clip.height * 2)}  ${kb} KB`);
}
const boxOf = async locator => await locator.boundingBox();

// The stats and the chart of the demo's desktop: wide, and full of things to point at.
const REGION = { x: 400, y: 172, w: 860, h: 390 };

if (!only) {
// 1. Mid-selection: the veil, the clear region, the guides through the pointer and the readout.
await page.locator('.tray').click();
await page.locator('.tray-menu [data-act="capture"]').click();
const overlay = page.frameLocator('.overlay');
await overlay.locator('.veil').waitFor();
await drag(at(REGION.x, REGION.y), at(REGION.x + REGION.w, REGION.y + REGION.h), false);
await page.waitForTimeout(250);
// Cropped to the selection and its surroundings: on the page it is shown at a
// fraction of the desktop's size, and the readout has to stay legible.
const around = { x: stage.x + 270, y: stage.y + 100, width: 1060, height: 660 };
await shot('select', around, 'jpeg');
await page.mouse.up();
await overlay.locator('.panel').waitFor();

// 2. The editor, marked up: a box, an arrow at the chart's peak, a note and a redaction.
await overlay.getByRole('button', { name: 'Capture', exact: true }).click();
const win = page.locator('.win.editor');
await win.waitFor({ state: 'visible' });
await editor.locator('.capture').waitFor();
await page.waitForTimeout(300);
const image = await boxOf(editor.locator('.overlay'));
const k = image.width / REGION.w;                      // screen px per scene point
const on = (x, y) => ({ x: image.x + (x - REGION.x) * k, y: image.y + (y - REGION.y) * k });
// The rail is slots now, each wearing one of its ways, so a tool is asked for
// by the name it is wearing rather than by an id.
const tool = name => editor.getByRole('radio', { name, exact: true }).click();
// The size slider is a range input; Playwright cannot fill one, so set it the way a drag would.
const size = value => editor.locator('.weight').evaluate((el, v) => {
  el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
}, String(value));
// A fresh annotation stays selected, and the size control restyles a selection
// rather than setting the next one, so clear it first. Shapes and segments show
// handles, a note a dashed outline; Escape with nothing selected would close
// the editor, hence the check.
async function deselect() { if (await editor.locator('.handle, .note-outline').count()) await page.keyboard.press('Escape'); }

await size(0.55); await tool('Box');    await drag(on(1046, 184), on(1254, 288)); await deselect();
await size(1);    await tool('Arrow');  await drag(on(790, 500), on(934, 380));   await deselect();
await size(0.8);  await tool('Text');   await page.mouse.click(on(944, 404).x, on(944, 404).y);
await page.keyboard.type('Launch day'); await page.keyboard.press('Escape');    await deselect();
await size(1);    await tool('Redact'); await drag(on(424, 220), on(538, 256));  await deselect();
await tool('Arrow');                                   // the tool the picture should show chosen
await page.mouse.move(stage.x + 20, stage.y + 880);    // and nothing hovered
await page.waitForTimeout(400);
const winBox = await boxOf(win);
await shot('hero', winBox);
await shot('redact', { x: on(404, 184).x, y: on(404, 184).y, width: 216 * k, height: 106 * k });   // the card whose number is now blocks

// 3. Settings, then the light appearance of the same editor.
await editor.getByRole('button', { name: 'Settings' }).click();
const settingsWin = page.locator('.win.settings');
await settingsWin.waitFor({ state: 'visible' });
const settings = page.frameLocator('.win.settings iframe');
await settings.locator('.pref-version').waitFor();
await page.waitForTimeout(400);
await shot('settings', await boxOf(settingsWin));
await settings.getByRole('radio', { name: 'Light' }).click();
await page.waitForTimeout(400);
await settingsWin.locator('.light.close').click();
await settingsWin.waitFor({ state: 'hidden' });
await page.mouse.move(stage.x + 20, stage.y + 880);
await page.waitForTimeout(400);
await shot('hero-light', await boxOf(win));

// 4. Framed: the same marked-up capture on a gradient, with a title bar, as
// Frame shows it on the canvas -- which is what it copies.
await editor.getByRole('button', { name: 'Frame', exact: true }).click();
const framing = editor.locator('.frame-panel');
await framing.waitFor({ state: 'visible' });
await framing.getByRole('radio', { name: 'Aurora', exact: true }).click();
await framing.getByLabel('Title bar').check();
await page.keyboard.press('Escape');                   // the panel goes; the frame stays
await framing.waitFor({ state: 'hidden' });
await page.mouse.move(stage.x + 20, stage.y + 880);
await page.waitForTimeout(400);
await shot('frame', await boxOf(editor.locator('.backdrop')));
}

// 5. Claude asks: the editor in request mode, over a capture of the chart with
// two numbered steps -- and, printed, the very words Send gave Claude with it.
if (!only || only === 'ask') {
  await page.goto(`${origin}/demo.html`);
  await editor.getByRole('heading', { name: 'Capture your screen' }).waitFor();
  await page.evaluate(() => window.postMessage('mark-demo:ask', location.origin));
  await editor.locator('.request-bar').waitFor();
  await editor.locator('[data-start="region"]').click();
  await page.frameLocator('.overlay').locator('.veil').waitFor();
  await drag(at(REGION.x, REGION.y), at(REGION.x + REGION.w, REGION.y + REGION.h));
  await page.frameLocator('.overlay').getByRole('button', { name: 'Capture', exact: true }).click();
  await editor.locator('.capture').waitFor();
  await page.waitForTimeout(300);
  const image = await boxOf(editor.locator('.overlay'));
  const k = image.width / REGION.w;
  const on = (x, y) => ({ x: image.x + (x - REGION.x) * k, y: image.y + (y - REGION.y) * k });
  // The arrow slot's numbered way, from its menu, as a right-click offers it.
  await editor.locator('.tool[data-slot="0"]').click({ button: 'right' });
  await editor.locator('.tool-menu button', { hasText: 'Numbered arrow' }).click();
  await drag(on(820, 470), on(934, 384));
  await page.keyboard.type('Launch day: why the spike?');
  await page.keyboard.press('Escape');
  await drag(on(996, 462), on(1016, 364));
  await page.keyboard.type('And why it held');
  await page.keyboard.press('Escape');
  if (await editor.locator('.handle, .note-outline').count()) await page.keyboard.press('Escape');
  await page.mouse.move(stage.x + 20, stage.y + 880);
  await page.waitForTimeout(400);
  await shot('ask', await boxOf(page.locator('.win.editor')));
  await editor.getByRole('button', { name: /^Send to Claude/ }).click();
  await page.locator('.sent').waitFor();
  console.log('\n--- what Claude received ---\n' + await page.locator('.sent-text').textContent());
}

await browser.close();
