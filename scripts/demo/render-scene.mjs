// Renders scripts/demo/scene.html to public/demo/scene.jpg at 2x. Run after
// changing the scene:  node scripts/demo/render-scene.mjs
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto('file://' + path.join(here, 'scene.html'));
await page.waitForTimeout(150);
// JPEG: the wallpaper's gradients defeat PNG compression (1.3 MB); at this
// quality the UI text stays crisp at 2x and the file is a fraction of the size.
await page.screenshot({ path: path.join(here, '../../public/demo/scene.jpg'), type: 'jpeg', quality: 88 });
await browser.close();
console.log('public/demo/scene.jpg rendered at 2880 x 1800');
