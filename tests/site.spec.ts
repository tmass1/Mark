import { test, expect } from '@playwright/test';
import pkg from '../package.json' with { type: 'json' };

/** The site: what it says about the app has to be what the app says about
 *  itself, and the demo in its frame has to be the real demo. */

test.use({ viewport: { width: 1280, height: 900 } });

test('the site takes its version, shortcut and download from the app', async ({ page }) => {
  await page.goto('/site.html');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Say it with an arrow.');
  await expect(page.locator('.hero [data-version]')).toHaveText(pkg.version);
  await expect(page.locator('.hero [data-shortcut]')).toHaveText('⌘4');
  const dmg = `Mark_${pkg.version}_universal.dmg`;
  for (const link of await page.locator('[data-download]').all()) {
    await expect(link).toHaveAttribute('href', `./${dmg}`);
    await expect(link).toHaveAttribute('download', dmg);
  }
  // The three arrow styles are drawn by the editor's geometry, one path each.
  await expect(page.locator('.arrows svg path')).toHaveCount(3);
  await expect(page.locator('.arrows figcaption')).toHaveText(['Tapered', 'Solid', 'Thin']);
  // Every picture is a real file.
  for (const img of await page.locator('img').all()) {
    await img.scrollIntoViewIfNeeded();
    expect(await img.evaluate(el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
  }
});

test('the demo in the page is the real demo, framed without its caption', async ({ page }) => {
  await page.goto('/site.html');
  await page.locator('.demo').scrollIntoViewIfNeeded();
  const demo = page.frameLocator('.demo');
  await expect(demo.locator('html')).toHaveClass(/embedded/);
  await expect(demo.locator('.caption')).toBeHidden();
  const editor = demo.frameLocator('.win.editor iframe');
  await expect(editor.getByRole('heading', { name: 'Capture a region' })).toBeVisible();
  await expect(editor.locator('.start kbd')).toHaveText('⌘4');
});

test('the bar’s links reach their sections', async ({ page }) => {
  await page.goto('/site.html');
  await page.getByRole('navigation', { name: 'Site' }).getByRole('link', { name: 'Try it' }).click();
  await expect(page).toHaveURL(/#try$/);
  await expect(page.getByRole('heading', { name: 'Try it here.' })).toBeInViewport();
});

test('every page finds everything it asks for', async ({ page }) => {
  // The editor is loaded at the root and again from demo/, so a path that is
  // right from one is not automatically right from the other. This is the check
  // that caught the icon missing from the site and broken in the demo's frame.
  for (const at of ['/', '/demo.html', '/site.html']) {
    const missing: string[] = [];
    page.on('response', response => {
      // Only what was fetched over the wire: a data: or blob: URL has no status
      // worth reading, and the demo makes both.
      const url = new URL(response.url());
      if (url.protocol.startsWith('http') && response.status() >= 400) missing.push(url.pathname);
    });
    await page.goto(at, { waitUntil: 'networkidle' });
    expect(missing, at).toEqual([]);
    const broken = await page.evaluate(() =>
      // One that has been asked for and did not arrive. An img with no src yet
      // is waiting for one -- the demo's clipboard card holds one of those.
      [...document.images]
        .filter(img => img.getAttribute('src') && img.complete && !img.naturalWidth)
        .map(img => img.src));
    expect(broken, at).toEqual([]);
    page.removeAllListeners('response');
  }
});

test('the demo’s editor shows the icon on its empty state, from its own depth', async ({ page }) => {
  await page.goto('/demo.html');
  const editor = page.frameLocator('.win.editor iframe');
  await expect(editor.getByRole('heading', { name: 'Capture a region' })).toBeVisible();
  expect(await editor.locator('.viewfinder').evaluate(
    el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
});
