import { test, expect } from '@playwright/test';

test('browser preview has no native dependency and renders in light and dark', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByAltText('Captured screenshot, 1200 by 740 pixels')).toBeVisible();
  await expect(page.getByText('1200 × 740 px')).toBeVisible();
  await page.screenshot({ path: 'test-results/editor-light.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'test-results/editor-dark.png' });
  await page.setViewportSize({ width: 380, height: 280 });
  await expect(page.getByRole('button', { name: /Copy and Close/ })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('clipboard denial retains the capture and Escape dismisses without copying', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { write: async () => { throw new Error('Clipboard denied'); } } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Copy and Close/ }).click();
  await expect(page.getByRole('status')).toContainText('Clipboard denied');
  await expect(page.getByRole('img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('img')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Capture a region' })).toBeVisible();
});

test('localStorage size preferences notify another browser window', async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto('/'); await second.goto('/');
  await second.evaluate(async () => {
    const { preferences } = await import('/src/preferences.ts');
    const store = await preferences();
    await store.onSizeChange(size => { document.body.dataset.observedSize = JSON.stringify(size); });
  });
  await first.evaluate(async () => {
    const { preferences } = await import('/src/preferences.ts');
    await (await preferences()).setSize({ width: 900, height: 620 });
  });
  await expect(second.locator('body')).toHaveAttribute('data-observed-size', '{"width":900,"height":620}');
  expect(await second.evaluate(() => JSON.parse(localStorage.getItem('mark.editorSize')!))).toEqual({ width: 900, height: 620 });
});

test('choosing a local image updates dimensions and copy uses PNG', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { write: async (items: ClipboardItem[]) => {
      const blob = await items[0].getType('image/png');
      document.body.dataset.copiedType = blob.type;
    } } });
  });
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles('src-tauri/icons/32x32.png');
  await expect(page.getByText('32 × 32 px')).toBeVisible();
  await page.getByRole('button', { name: /Copy and Close/ }).click();
  await expect(page.locator('body')).toHaveAttribute('data-copied-type', 'image/png');
  await expect(page.getByRole('img')).toBeHidden();
});

/** Overlay coordinates for a point in the 1200x740 sample capture. */
async function stage(page: import('@playwright/test').Page) {
  const box = (await page.locator('.overlay').boundingBox())!;
  return (ix: number, iy: number) => ({ x: box.x + (ix / 1200) * box.width, y: box.y + (iy / 740) * box.height });
}
async function drawArrow(page: import('@playwright/test').Page, from: [number, number], to: [number, number]) {
  const at = await stage(page);
  const a = at(...from), b = at(...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
}

test('draws an arrow, then restyles, moves, deletes and undoes it', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.toolbar')).toBeVisible();

  await drawArrow(page, [200, 200], [900, 200]);
  const arrow = page.locator('.arrow');
  await expect(arrow).toHaveCount(1);
  await expect(arrow).toHaveAttribute('fill', '#ff3b30');
  await expect(page.locator('.handle')).toHaveCount(2);

  // A drawn arrow stays selected, so a swatch recolors it rather than only the next one.
  await page.locator('.swatch[data-color="#007aff"]').click();
  await expect(arrow).toHaveAttribute('fill', '#007aff');

  const thin = await arrow.getAttribute('d');
  await page.locator('.weight').fill('2.5');
  await expect(arrow).not.toHaveAttribute('d', thin!);

  // Grab the fattened shaft and shift it down: one arrow, in a new place.
  const before = await arrow.getAttribute('d');
  const at = await stage(page);
  const grab = at(550, 200), drop = at(550, 400);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(drop.x, drop.y, { steps: 10 });
  await page.mouse.up();
  await expect(arrow).toHaveCount(1);
  const moved = await arrow.getAttribute('d');
  expect(moved).not.toEqual(before);

  await page.keyboard.press('Delete');
  await expect(page.locator('.arrow')).toHaveCount(0);
  await page.keyboard.press('Meta+z');
  await expect(page.locator('.arrow')).toHaveCount(1);
  await expect(page.locator('.arrow')).toHaveAttribute('d', moved!);
});

test('a click without a drag leaves no arrow behind', async ({ page }) => {
  await page.goto('/');
  const at = await stage(page);
  const point = at(400, 300);
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('.arrow')).toHaveCount(0);
});

test('Escape clears the selection before it closes the editor', async ({ page }) => {
  await page.goto('/');
  await drawArrow(page, [200, 200], [700, 500]);
  await expect(page.locator('.handle')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('.handle')).toHaveCount(0);
  await expect(page.getByRole('img')).toBeVisible();   // still open
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Capture a region' })).toBeVisible();
});

test('the copied image carries the arrow at full resolution', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { write: async (items: any[]) => {
      const blob = await items[0].getType('image/png');
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const [r, g, b] = context.getImageData(550, 200, 1, 1).data;
      document.body.dataset.copiedSize = `${bitmap.width}x${bitmap.height}`;
      document.body.dataset.copiedPixel = `${r},${g},${b}`;
    } } });
  });
  await page.goto('/');
  await drawArrow(page, [200, 200], [900, 200]);
  await page.getByRole('button', { name: /Copy and Close/ }).click();
  // Full capture size, and the shaft is on the pixel it was drawn over.
  await expect(page.locator('body')).toHaveAttribute('data-copied-size', '1200x740');
  await expect(page.locator('body')).toHaveAttribute('data-copied-pixel', '255,59,48');
});

test('types a text note, moves it, and reopens it on double click', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('radio', { name: 'Text' }).click();
  const at = await stage(page);
  const spot = at(300, 250);
  await page.mouse.click(spot.x, spot.y);

  const editor = page.locator('.text-editor');
  await expect(editor).toBeVisible();
  await page.keyboard.type('Look here');
  await page.keyboard.press('Escape');          // commits, and must not close the editor
  await expect(editor).toBeHidden();
  await expect(page.locator('.note text')).toHaveText('Look here');
  await expect(page.getByRole('img', { name: /Captured screenshot/ })).toBeVisible();

  const before = await page.locator('.note text').getAttribute('x');
  const grab = at(330, 265), drop = at(700, 480);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(drop.x, drop.y, { steps: 10 });
  await page.mouse.up();
  expect(await page.locator('.note text').getAttribute('x')).not.toEqual(before);

  await page.locator('.note').dblclick();
  await expect(editor).toBeVisible();
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  await expect(page.locator('.note text')).toHaveText('Look here!');
});

test('a text box left empty leaves nothing behind', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('radio', { name: 'Text' }).click();
  const at = await stage(page);
  const spot = at(400, 300);
  await page.mouse.click(spot.x, spot.y);
  await expect(page.locator('.text-editor')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.note')).toHaveCount(0);
  await expect(page.locator('.text-editor')).toBeHidden();
});

test('text takes the toolbar colour and the copied image carries it', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { write: async (items: any[]) => {
      const blob = await items[0].getType('image/png');
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      // Scan the box the text was typed into for its exact colour.
      const { data } = context.getImageData(290, 240, 320, 70);
      let hits = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] === 0 && data[i + 1] === 122 && data[i + 2] === 255) hits++;
      }
      document.body.dataset.textPixels = String(hits);
    } } });
  });
  await page.goto('/');
  await page.getByRole('radio', { name: 'Text' }).click();
  await page.locator('.swatch[data-color="#007aff"]').click();
  const at = await stage(page);
  const spot = at(300, 250);
  await page.mouse.click(spot.x, spot.y);
  await page.keyboard.type('Look here');
  await page.keyboard.press('Escape');
  await expect(page.locator('.note text')).toHaveAttribute('fill', '#007aff');

  await page.getByRole('button', { name: /Copy and Close/ }).click();
  // Flattening is async; poll rather than read once.
  await expect.poll(async () => Number(await page.locator('body').getAttribute('data-text-pixels')))
    .toBeGreaterThan(100);
});

test('arrows and text can be mixed on one capture', async ({ page }) => {
  await page.goto('/');
  await drawArrow(page, [200, 600], [500, 400]);
  await page.getByRole('radio', { name: 'Text' }).click();
  const at = await stage(page);
  const spot = at(560, 360);
  await page.mouse.click(spot.x, spot.y);
  await page.keyboard.type('Here');
  await page.keyboard.press('Escape');
  await expect(page.locator('.arrow')).toHaveCount(1);
  await expect(page.locator('.note')).toHaveCount(1);
  // Undo peels off the text and leaves the arrow.
  await page.keyboard.press('Meta+z');
  await expect(page.locator('.note')).toHaveCount(0);
  await expect(page.locator('.arrow')).toHaveCount(1);
});
