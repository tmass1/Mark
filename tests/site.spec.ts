import { test, expect } from '@playwright/test';
import pkg from '../package.json' with { type: 'json' };

/** The site: what it says about the app has to be what the app says about
 *  itself, and the demo in its frame has to be the real demo. */

test.use({ viewport: { width: 1280, height: 900 } });

test('the site takes its version, shortcut and download from the app', async ({ page }) => {
  await page.goto('/site.html');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Show Claude what you mean.');
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
  // Every picture shown is a real file. (The hero's picture is a phone's, below.)
  for (const img of await page.locator('img').all()) {
    if (!await img.isVisible()) continue;
    await img.scrollIntoViewIfNeeded();
    expect(await img.evaluate(el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
  }
});

test('a callout says the demo is live, and goes once the demo is used', async ({ page }) => {
  await page.goto('/site.html');
  // The demo is right there, so the hero has no button to go and find it.
  await expect(page.getByRole('link', { name: 'Try it in your browser' })).toHaveCount(0);
  const callout = page.locator('.try-me');
  await expect(callout).toBeVisible();
  await expect(callout).toHaveText('Try me — it’s the real app, live');
  // Above the demo, clear of the line above it.
  const above = (await callout.boundingBox())!, frame = (await page.locator('.demo-frame').boundingBox())!;
  const fine = (await page.locator('.hero .fine').boundingBox())!;
  expect(above.y + above.height).toBeLessThan(frame.y);
  expect(above.y).toBeGreaterThan(fine.y + fine.height);
  // Switching away from the page leaves it; using the demo takes it away.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(50);
  await expect(callout).not.toHaveClass(/used/);
  const demo = page.frameLocator('.demo');
  await expect(demo.frameLocator('.win.editor iframe').getByRole('heading', { name: 'Capture your screen' })).toBeVisible();
  await page.locator('.demo').click({ position: { x: 40, y: 200 } });
  await expect(callout).toHaveClass(/used/);
  await expect(callout).toHaveCSS('opacity', '0');
});

test('“Let Claude ask” has the demo play Claude asking, for the visitor to answer', async ({ page }) => {
  await page.goto('/site.html');
  const editor = page.frameLocator('.demo').frameLocator('.win.editor iframe');
  await expect(editor.getByRole('heading', { name: 'Capture your screen' })).toBeVisible();
  await page.getByRole('button', { name: 'Let Claude ask' }).click();
  await expect(editor.locator('.request-bar')).toContainText('Claude asks to see “the chart’s peak”');
  await expect(page.locator('.demo')).toBeInViewport();
  await expect(page.locator('.try-me')).toHaveClass(/used/);
});

test('the setup line copies as it reads', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { (window as any).__copied = text; } } });
  });
  await page.goto('/site.html');
  const command = page.locator('.command code');
  await page.locator('.copy-command').click();
  await expect(page.locator('.copy-command')).toHaveText('Copied');
  expect(await page.evaluate(() => (window as any).__copied)).toBe(await command.textContent());
  expect(await command.textContent()).toBe("claude mcp add --scope user mark -- '/Applications/Mark.app/Contents/MacOS/mark' --mcp");
});

test('the hero is the real demo, framed without its caption', async ({ page }) => {
  await page.goto('/site.html');
  // Where the picture of the app used to be, under the heading and the buttons.
  await expect(page.locator('.hero .demo')).toHaveCount(1);
  await expect(page.locator('.demo')).toHaveCount(1);
  await expect(page.locator('.hero .hero-shot')).toBeHidden();
  const demo = page.frameLocator('.demo');
  await expect(demo.locator('html')).toHaveClass(/embedded/);
  await expect(demo.locator('.caption')).toBeHidden();
  const editor = demo.frameLocator('.win.editor iframe');
  await expect(editor.getByRole('heading', { name: 'Capture your screen' })).toBeVisible();
  await expect(editor.locator('.start kbd')).toHaveText('⌘4');
});

test('the bar’s links reach their sections', async ({ page }) => {
  await page.goto('/site.html');
  await page.locator('#features').scrollIntoViewIfNeeded();
  await page.getByRole('navigation', { name: 'Site' }).getByRole('link', { name: 'Try it' }).click();
  await expect(page).toHaveURL(/#try$/);
  await expect(page.locator('.demo')).toBeInViewport();
});

test('a phone gets the picture of the app, and never loads the demo', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', request => asked.push(new URL(request.url()).pathname));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/site.html', { waitUntil: 'networkidle' });
  const picture = page.locator('.hero .hero-shot img');
  await expect(picture).toBeVisible();
  await picture.scrollIntoViewIfNeeded();
  await expect.poll(() => picture.evaluate(el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
  await expect(page.locator('.demo-frame')).toBeHidden();
  await expect(page.locator('.try-me')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Let Claude ask' })).toBeHidden();
  await expect(page.getByText('The demo wants a pointer and a keyboard.')).toBeVisible();
  expect(asked.filter(path => path.endsWith('demo.html'))).toEqual([]);
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
  await expect(editor.getByRole('heading', { name: 'Capture your screen' })).toBeVisible();
  expect(await editor.locator('.viewfinder').evaluate(
    el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
});
