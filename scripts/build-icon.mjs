// Regenerates Mark's icon at every size, plus the menu bar glyph.
// Run from the project root:  OUT=/tmp/mark-icons node scripts/build-icon.mjs
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
const out = process.env.OUT ?? new URL('../src-tauri/icons', import.meta.url).pathname;

/** The app's own arrow, verbatim from src/annotations.ts. */
function arrowPolygon(a) {
  const dx = a.x2 - a.x1, dy = a.y2 - a.y1;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length, uy = dy / length, nx = -uy, ny = ux;
  const head = Math.min(a.weight * 3.2, length * 0.44);
  const halfHead = a.weight * 1.5, tailHalf = a.weight * 0.16, baseHalf = a.weight * 0.5;
  const bx = a.x2 - ux * head, by = a.y2 - uy * head;
  const off = (px, py, d) => [px + nx * d, py + ny * d];
  return [off(a.x1, a.y1, tailHalf), off(bx, by, baseHalf), off(bx, by, halfHead),
          [a.x2, a.y2], off(bx, by, -halfHead), off(bx, by, -baseHalf), off(a.x1, a.y1, -tailHalf)];
}
const poly = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ') + 'Z';

/** Apple's icon shape is a continuous-corner squircle, not a rounded rect. A
 *  superellipse at n = 5 is very close, and sampling it beats guessing at
 *  Bezier control points. */
function squircle(cx, cy, half, n = 5) {
  const points = [];
  for (let i = 0; i <= 360; i++) {
    const t = (i / 360) * Math.PI * 2;
    const cos = Math.cos(t), sin = Math.sin(t);
    points.push([
      cx + half * Math.sign(cos) * Math.abs(cos) ** (2 / n),
      cy + half * Math.sign(sin) * Math.abs(sin) ** (2 / n),
    ]);
  }
  return poly(points);
}

/** Apple's macOS grid: 824 of a 1024 canvas, centred, leaving the margin the
 *  system expects for shadow and alignment. */
const SHAPE = squircle(512, 512, 412);

/** Detail is chosen per size, not scaled: the content lines are the idea at
 *  large sizes and noise at small ones, so below 128px they simply are not
 *  drawn and the icon degrades to the arrow alone. */
function icon(px) {
  const lines = px >= 128;
  const weight = px >= 128 ? 74 : 92;          // heavier when small, to hold up
  const arrow = poly(arrowPolygon({ x1: 792, y1: 232, x2: 322, y2: 702, weight }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${px}" height="${px}">
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#43454e"/><stop offset="1" stop-color="#1a1b1f"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".16"/>
      <stop offset=".45" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <path d="${SHAPE}" fill="url(#ground)"/>
  ${lines ? `<g fill="#ffffff" opacity=".13">
    <rect x="236" y="300" width="392" height="34" rx="17"/>
    <rect x="236" y="382" width="250" height="34" rx="17"/>
    <rect x="236" y="464" width="318" height="34" rx="17"/>
  </g>` : ''}
  <path d="${arrow}" fill="#ff453a"/>
  <path d="${SHAPE}" fill="url(#sheen)"/>
</svg>`;
}

/** Menu bar: alpha only, so macOS can tint it for light, dark and highlight. */
const tray = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="44" height="44">
  <path d="${poly(arrowPolygon({ x1: 872, y1: 152, x2: 232, y2: 792, weight: 118 }))}" fill="#000000"/>
</svg>`;

const sizes = [16, 32, 64, 128, 256, 512, 1024];
mkdirSync(`${out}/iconset`, { recursive: true });
for (const px of sizes) writeFileSync(`${out}/icon-${px}.svg`, icon(px));
writeFileSync(`${out}/tray.svg`, tray);
writeFileSync(`${out}/app-icon.svg`, icon(1024));

const browser = await chromium.launch();
async function render(svgPath, px, target) {
  const page = await browser.newPage({ viewport: { width: px, height: px }, deviceScaleFactor: 1 });
  await page.goto('file://' + svgPath);
  await page.screenshot({ path: target, omitBackground: true });
  await page.close();
}
for (const px of sizes) await render(`${out}/icon-${px}.svg`, px, `${out}/png-${px}.png`);
await render(`${out}/tray.svg`, 44, `${out}/tray.png`);
await browser.close();
console.log('rendered', sizes.join(' '), 'and tray');
