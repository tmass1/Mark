// Renders scripts/demo/scene.html to public/demo/scene*.jpg at 2x. Run after
// changing the scene:  node scripts/demo/render-scene.mjs
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
// JPEG: the wallpaper's gradients defeat PNG compression (1.3 MB); at this
// quality the UI text stays crisp at 2x and the file is a fraction of the size.
// The desktop as it opens, then what its dashboard answers each click with.
const STATES = { scene: '', 'scene-7d': '?range=7d', 'scene-90d': '?range=90d', 'scene-1y': '?range=1y',
                 'scene-orders': '?page=Orders', 'scene-customers': '?page=Customers' };
for (const [name, query] of Object.entries(STATES)) {
  await page.goto('file://' + path.join(here, 'scene.html') + query);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(here, `../../public/demo/${name}.jpg`), type: 'jpeg', quality: 88 });
}
await browser.close();
console.log('public/demo/scene*.jpg rendered at 2880 x 1800');
