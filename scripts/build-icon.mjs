// Renders Mark's icon set from the artwork in brand/: the app icon at every
// size and the .icns, the picture the site shows, the menu bar glyph, and
// src/mark.ts for the editor's empty state.
// Run from the project root:  node scripts/build-icon.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const icons = path.join(root, 'src-tauri/icons');
const work = path.join(root, 'src-tauri/target/icon-build');
/** The icon as Tommy draws it: a square picture, edge to edge. */
const picture = 'data:image/png;base64,' + readFileSync(path.join(root, 'brand/mark.png')).toString('base64');
/** And the vector arrow, which the two places that need a shape rather than a
 *  picture come from: the menu bar, whose glyph macOS tints itself, and the
 *  editor's empty state, which draws in the brand red. */
const svg = readFileSync(path.join(root, 'brand/mark-dark.svg'), 'utf8');
rmSync(work, { recursive: true, force: true }); mkdirSync(path.join(work, 'Mark.iconset'), { recursive: true });

/** Apple's icon shape is a continuous-corner squircle, not a rounded rectangle.
 *  A superellipse at n = 5 is very close, and sampling it beats guessing at
 *  Bezier control points. */
function squircle(cx, cy, half, n = 5) {
  const points = [];
  for (let i = 0; i <= 360; i++) {
    const t = (i / 360) * Math.PI * 2, cos = Math.cos(t), sin = Math.sin(t);
    points.push([cx + half * Math.sign(cos) * Math.abs(cos) ** (2 / n),
                 cy + half * Math.sign(sin) * Math.abs(sin) ** (2 / n)]);
  }
  return points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ') + 'Z';
}
/** The picture cut to that shape. On macOS it sits on Apple's grid -- 824 of a
 *  1024 canvas, centred, leaving the margin the system expects for shadow and
 *  alignment; on the web it fills the square, where the mark is small and a
 *  margin would only cost pixels. */
const cut = (px, inset) => {
  const half = 512 - inset;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${px}" height="${px}">
  <defs><clipPath id="shape"><path d="${squircle(512, 512, half)}"/></clipPath></defs>
  <image href="${picture}" x="${inset}" y="${inset}" width="${half * 2}" height="${half * 2}" clip-path="url(#shape)"/>
</svg>`;
};

// ---- the arrow the menu bar needs as a shape ---------------------------------------
/** The arrow is the first path under the arrow's shadow filter. The menu bar
 *  wants a shape rather than a picture, which is the only thing the vector
 *  drawing is still needed for. */
const arrow = svg.match(/<g filter="url\(#arrow-shadow\)">\s*<path d="([^"]+)"/)?.[1];
if (!arrow) throw new Error('brand/mark-dark.svg has changed shape; update the match above.');

// ---- the menu bar glyph -----------------------------------------------------------------
/** Alpha only, so macOS tints it for light, dark and highlighted menu bars; the
 *  arrow alone, scaled to fill the canvas, since the corners are clutter at 22
 *  points. The bounds come from the path's own numbers. */
const numbers = arrow.match(/-?\d+(?:\.\d+)?/g).map(Number);
const xs = numbers.filter((_, i) => i % 2 === 0), ys = numbers.filter((_, i) => i % 2 === 1);
const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
const fit = 900 / Math.max(box.w, box.h);
const tray = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="44" height="44">
  <path d="${arrow}" fill="#000000" transform="translate(512 512) scale(${fit.toFixed(4)}) translate(${(-(box.x + box.w / 2)).toFixed(1)} ${(-(box.y + box.h / 2)).toFixed(1)})"/>
</svg>`;
writeFileSync(path.join(work, 'tray.svg'), tray);

// ---- the icon at every size ---------------------------------------------------------------
const sizes = [16, 32, 64, 128, 256, 512, 1024];
for (const px of sizes) writeFileSync(path.join(work, `icon-${px}.svg`), cut(px, 100));
writeFileSync(path.join(work, 'web.svg'), cut(512, 0));

const browser = await chromium.launch();
async function render(file, px, target) {
  const page = await browser.newPage({ viewport: { width: px, height: px }, deviceScaleFactor: 1 });
  await page.goto('file://' + file);
  await page.screenshot({ path: target, omitBackground: true });
  await page.close();
}
for (const px of sizes) await render(path.join(work, `icon-${px}.svg`), px, path.join(work, `icon-${px}.png`));
await render(path.join(work, 'tray.svg'), 44, path.join(icons, 'tray.png'));
// The one the editor's empty state and the site both show: the same shape,
// filling its square, served from public/.
mkdirSync(path.join(root, 'public/brand'), { recursive: true });
await render(path.join(work, 'web.svg'), 512, path.join(root, 'public/brand/mark.png'));
await browser.close();

// What tauri.conf.json names, and what macOS's iconset wants.
const named = { '32x32.png': 32, '64x64.png': 64, '128x128.png': 128, '128x128@2x.png': 256, 'icon.png': 1024 };
for (const [name, px] of Object.entries(named)) copyFileSync(path.join(work, `icon-${px}.png`), path.join(icons, name));
const iconset = { 16: ['icon_16x16.png'], 32: ['icon_16x16@2x.png', 'icon_32x32.png'], 64: ['icon_32x32@2x.png'],
  128: ['icon_128x128.png'], 256: ['icon_128x128@2x.png', 'icon_256x256.png'], 512: ['icon_256x256@2x.png', 'icon_512x512.png'], 1024: ['icon_512x512@2x.png'] };
for (const [px, names] of Object.entries(iconset)) for (const name of names) copyFileSync(path.join(work, `icon-${px}.png`), path.join(work, 'Mark.iconset', name));
execFileSync('iconutil', ['--convert', 'icns', '--output', path.join(icons, 'icon.icns'), path.join(work, 'Mark.iconset')]);
console.log(`icons: ${Object.keys(named).join(', ')}, icon.icns, tray.png; and public/brand/mark.png`);
if (picture.length < 700_000) console.warn('note: brand/mark.png is small for a 1024 icon; a larger export would sharpen the big sizes.');
