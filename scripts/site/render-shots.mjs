// Renders the site's pictures of Mark from the web demo, so every picture is the
// real editor, overlay and settings rather than a mockup, and re-rendering after
// a design change is one command. Needs the dev server (pnpm dev), then:
//   node scripts/site/render-shots.mjs [http://127.0.0.1:1420]
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '../../public/site');
const origin = process.argv[2] ?? 'http://127.0.0.1:1420';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
// Wide enough that the stage is laid out at 1440 and not scaled: one stage
// point per scene point, so the numbers below are scene coordinates.
const page = await browser.newPage({ viewport: { width: 1472, height: 960 }, deviceScaleFactor: 2 });
await page.goto(`${origin}/demo.html`);
const editor = page.frameLocator('.win.editor iframe');
await editor.getByRole('heading', { name: 'Capture a region' }).waitFor();
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
const tool = name => editor.locator(`.tool[data-tool="${name}"]`).click();
// The size slider is a range input; Playwright cannot fill one, so set it the way a drag would.
const size = value => editor.locator('.weight').evaluate((el, v) => {
  el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
}, String(value));
// A fresh annotation stays selected, and the size control restyles a selection
// rather than setting the next one, so clear it first. Shapes and segments show
// handles, a note a dashed outline; Escape with nothing selected would close
// the editor, hence the check.
async function deselect() { if (await editor.locator('.handle, .note-outline').count()) await page.keyboard.press('Escape'); }

await size(0.55); await tool('box');    await drag(on(1046, 184), on(1254, 288)); await deselect();
await size(1);    await tool('arrow');  await drag(on(790, 500), on(934, 380));   await deselect();
await size(0.8);  await tool('text');   await page.mouse.click(on(944, 404).x, on(944, 404).y);
await page.keyboard.type('Launch day'); await page.keyboard.press('Escape');    await deselect();
await size(1);    await tool('redact'); await drag(on(424, 220), on(538, 256));  await deselect();
await tool('arrow');                                   // the tool the picture should show chosen
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

// 4. The menu bar item, open.
await page.locator('.tray').click();
await page.locator('.tray-menu').waitFor({ state: 'visible' });
await page.waitForTimeout(200);
await shot('menu', { x: stage.x + stage.width - 300, y: stage.y, width: 300, height: 150 });

await browser.close();
