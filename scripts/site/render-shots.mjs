// Renders the site's pictures of Mark from the web demo, so every picture is the
// real editor rather than a mockup, and re-rendering after a design change is
// one command. Needs the dev server (pnpm dev), then:
//   node scripts/site/render-shots.mjs [http://127.0.0.1:1420]
// ONLY=hero, ONLY=mockup or ONLY=ask renders just that picture, leaving the rest as they are.
// The pictures over made-up screens rather than the demo's are render-examples.mjs's.
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
async function shot(name, clip) {
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file, clip });
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(`${name}.png  ${Math.round(clip.width * 2)} x ${Math.round(clip.height * 2)}  ${kb} KB`);
}
const boxOf = async locator => await locator.boundingBox();
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
// The arrow slot's numbered way, from its menu, as a right-click offers it.
async function numbered() {
  await editor.locator('.tool[data-slot="0"]').click({ button: 'right' });
  await editor.locator('.tool-menu button', { hasText: 'Numbered arrow' }).click();
}

// The stats and the chart of the demo's desktop: wide, and full of things to point at.
const REGION = { x: 400, y: 172, w: 860, h: 390 };

// The editor, marked up: a box, an arrow at the chart's peak, a note and a
// redaction. The README's picture, and the demo's on a phone.
if (!only || only === 'hero') {
await page.locator('.tray').click();
await page.locator('.tray-menu [data-act="capture"]').click();
const overlay = page.frameLocator('.overlay');
await overlay.locator('.veil').waitFor();
await drag(at(REGION.x, REGION.y), at(REGION.x + REGION.w, REGION.y + REGION.h));
await overlay.locator('.panel').waitFor();
await overlay.getByRole('button', { name: 'Capture', exact: true }).click();
const win = page.locator('.win.editor');
await win.waitFor({ state: 'visible' });
await editor.locator('.capture').waitFor();
await page.waitForTimeout(300);
const image = await boxOf(editor.locator('.overlay'));
const k = image.width / REGION.w;                      // screen px per scene point
const on = (x, y) => ({ x: image.x + (x - REGION.x) * k, y: image.y + (y - REGION.y) * k });

await size(0.55); await tool('Box');    await drag(on(1046, 184), on(1254, 288)); await deselect();
await size(1);    await tool('Arrow');  await drag(on(790, 500), on(934, 380));   await deselect();
await size(0.8);  await tool('Text');   await page.mouse.click(on(944, 404).x, on(944, 404).y);
await page.keyboard.type('Launch day'); await page.keyboard.press('Escape');    await deselect();
await size(1);    await tool('Redact'); await drag(on(424, 220), on(538, 256));  await deselect();
await tool('Arrow');                                   // the tool the picture should show chosen
await page.mouse.move(stage.x + 20, stage.y + 880);    // and nothing hovered
await page.waitForTimeout(400);
await shot('hero', await boxOf(win));
}

// A mock-up: the dashboard, range buttons and all, with three numbered changes
// and the notes framed on the picture. The page's picture of the editor on a
// phone, and its preview where a link to it is shared.
if (!only || only === 'mockup') {
  const region = { x: 400, y: 118, w: 860, h: 442 };
  await page.goto(`${origin}/demo.html`);
  await editor.getByRole('heading', { name: 'Capture your screen' }).waitFor();
  await editor.locator('[data-start="region"]').click();
  await page.frameLocator('.overlay').locator('.veil').waitFor();
  await drag(at(region.x, region.y), at(region.x + region.w, region.y + region.h));
  await page.frameLocator('.overlay').getByRole('button', { name: 'Capture', exact: true }).click();
  await editor.locator('.capture').waitFor();
  await page.waitForTimeout(300);
  const image = await boxOf(editor.locator('.overlay'));
  const k = image.width / region.w;
  const on = (x, y) => ({ x: image.x + (x - region.x) * k, y: image.y + (y - region.y) * k });
  await numbered();
  await size(0.8);
  for (const [from, to, note] of [
    [[700, 143], [1003, 143], 'Add an “All time” range'],
    [[600, 360], [936, 364], 'Show the day’s total on hover'],
    [[450, 520], [760, 468], 'Label the dashed line “Last year”'],
  ]) {
    await drag(on(...from), on(...to));
    await page.keyboard.type(note);
    await page.keyboard.press('Escape');
  }
  await deselect();
  await editor.getByRole('button', { name: /^Steps/ }).first().click();
  await page.waitForTimeout(300);
  await editor.getByRole('radio', { name: 'Framed', exact: true }).click();
  await page.waitForTimeout(200);
  await editor.locator('.steps-close').click();
  await page.mouse.move(stage.x + 20, stage.y + 880);
  await page.waitForTimeout(400);
  await shot('mockup', await boxOf(page.locator('.win.editor')));
}

// Claude asks: the editor in request mode, over a capture of the chart with
// two numbered steps -- and, printed, the very words Send gave Claude with it.
// The guide's preview where a link to it is shared.
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
  await numbered();
  await drag(on(820, 470), on(934, 384));
  await page.keyboard.type('Launch day: why the spike?');
  await page.keyboard.press('Escape');
  await drag(on(996, 462), on(1016, 364));
  await page.keyboard.type('And why it held');
  await page.keyboard.press('Escape');
  await deselect();
  await page.mouse.move(stage.x + 20, stage.y + 880);
  await page.waitForTimeout(400);
  await shot('ask', await boxOf(page.locator('.win.editor')));
  await editor.getByRole('button', { name: /^Send to Claude/ }).click();
  await page.locator('.sent').waitFor();
  console.log('\n--- what Claude received ---\n' + await page.locator('.sent-text').textContent());
}

await browser.close();
