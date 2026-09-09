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

async function pick(page: import('@playwright/test').Page, tool: string) {
  await page.getByRole('radio', { name: tool, exact: true }).click();
}

test('draws a box and an ellipse, and resizes one by its corner', async ({ page }) => {
  await page.goto('/');
  await pick(page, 'Box');
  await drawArrow(page, [200, 200], [600, 420]);        // a drag is a drag
  const box = page.locator('.shape rect[stroke="#ff3b30"]');
  await expect(box).toHaveCount(1);
  await expect(page.locator('.handle')).toHaveCount(4);  // four corners, not two ends

  const width = Number(await box.getAttribute('width'));
  const at = await stage(page);
  const grip = at(600, 420), pull = at(900, 560);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(pull.x, pull.y, { steps: 10 });
  await page.mouse.up();
  expect(Number(await box.getAttribute('width'))).toBeGreaterThan(width);

  await pick(page, 'Ellipse');
  await drawArrow(page, [250, 500], [500, 650]);
  await expect(page.locator('.shape ellipse[stroke="#ff3b30"]')).toHaveCount(1);
});

test('highlighter ink is translucent so the screenshot reads through it', async ({ page }) => {
  await page.goto('/');
  await pick(page, 'Highlighter');
  await page.locator('.swatch[data-color="#ffcc00"]').click();
  await drawArrow(page, [150, 280], [700, 330]);
  const ink = page.locator('.highlight');
  await expect(ink).toHaveCount(1);
  await expect(ink).toHaveAttribute('fill', '#ffcc00');
  const style = await ink.evaluate(node => getComputedStyle(node));
  expect(Number(style.opacity)).toBeLessThan(1);
  expect(style.mixBlendMode).toBe('multiply');
});

test('redaction destroys the pixels underneath, not just the view of them', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { write: async (items: any[]) => {
      const blob = await items[0].getType('image/png');
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      // Count distinct colours inside the redacted region and in an untouched
      // strip of the same capture, for comparison.
      const distinct = (x: number, y: number, w: number, h: number) => {
        const { data } = context.getImageData(x, y, w, h);
        const seen = new Set<number>();
        for (let i = 0; i < data.length; i += 4) seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        return seen.size;
      };
      document.body.dataset.hidden = String(distinct(160, 240, 520, 40));
      document.body.dataset.untouched = String(distinct(160, 300, 520, 40));
    } } });
  });
  await page.goto('/');
  await pick(page, 'Redact');
  // Over the headline, which is antialiased text and so full of distinct greys.
  await drawArrow(page, [150, 230], [700, 290]);
  await expect(page.locator('.shape image')).toHaveCount(1);

  await page.getByRole('button', { name: /Copy and Close/ }).click();
  await expect.poll(async () => await page.locator('body').getAttribute('data-hidden')).not.toBeNull();
  const hidden = Number(await page.locator('body').getAttribute('data-hidden'));
  const untouched = Number(await page.locator('body').getAttribute('data-untouched'));
  // Blocks, not a smear: far fewer colours than the text it replaced...
  expect(hidden).toBeLessThan(90);
  expect(untouched).toBeGreaterThan(hidden * 2);
  // ...but sampled from the real image, not painted over with one flat colour.
  expect(hidden).toBeGreaterThan(1);
});

test('a redaction keeps covering its region while it is being dragged', async ({ page }) => {
  await page.goto('/');
  await pick(page, 'Redact');
  const at = await stage(page);
  const from = at(200, 200), to = at(600, 400);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  // Mid-drag there is no patch yet, so it must be an opaque block, never see-through.
  await expect(page.locator('.redact-pending')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator('.redact-pending')).toHaveCount(0);
  await expect(page.locator('.shape image')).toHaveCount(1);
});

test('the redaction shown on screen is of the region it covers', async ({ page }) => {
  await page.goto('/');
  await pick(page, 'Redact');
  // Straight over the sample's blue call-to-action button.
  await drawArrow(page, [170, 430], [360, 480]);
  const patch = page.locator('.shape image');
  await expect(patch).toHaveCount(1);

  const middle = await page.evaluate(async () => {
    const href = document.querySelector('.shape image')!.getAttribute('href')!;
    const image = new Image();
    await new Promise(done => { image.onload = done; image.src = href; });
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const [r, g, b] = context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data;
    return { r, g, b };
  });
  // Blue, because that is what is underneath -- not the colour of the image's
  // top-left corner, which is what a source rectangle left at the origin gives.
  expect(middle.b).toBeGreaterThan(200);
  expect(middle.r).toBeLessThan(120);
  expect(middle.g).toBeLessThan(200);
});

test('copies and pastes an annotation, and duplicates one directly', async ({ page }) => {
  await page.goto('/');
  await drawArrow(page, [200, 200], [600, 300]);
  await expect(page.locator('.arrow')).toHaveCount(1);

  // The arrow is still selected, so Command-C takes it rather than the image,
  // and says so instead of quietly changing meaning.
  await page.keyboard.press('Meta+c');
  await expect(page.getByRole('status')).toContainText('Arrow copied');
  await expect(page.getByRole('img', { name: /Captured screenshot/ })).toBeVisible();

  await page.keyboard.press('Meta+v');
  await expect(page.locator('.arrow')).toHaveCount(2);
  // Pasting again cascades rather than stacking in one spot.
  await page.keyboard.press('Meta+v');
  await expect(page.locator('.arrow')).toHaveCount(3);
  const paths = await page.locator('.arrow').evaluateAll(nodes => nodes.map(n => n.getAttribute('d')));
  expect(new Set(paths).size).toBe(3);

  await page.keyboard.press('Meta+d');
  await expect(page.locator('.arrow')).toHaveCount(4);
});

test('with nothing selected Command-C still copies the image and closes', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { write: async () => {} } });
  });
  await page.goto('/');
  await drawArrow(page, [200, 200], [600, 300]);
  await page.keyboard.press('Escape');                 // clears the selection
  await expect(page.locator('.handle')).toHaveCount(0);
  await page.keyboard.press('Meta+c');
  await expect(page.getByRole('heading', { name: 'Capture a region' })).toBeVisible();
});

test('Copy keeps the capture open so you can carry on', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { write: async () => {} } });
  });
  await page.goto('/');
  await drawArrow(page, [200, 200], [600, 300]);
  await page.getByRole('button', { name: /^Copy/ }).first().click();
  await expect(page.getByRole('status')).toContainText('Copied to clipboard');
  await expect(page.getByRole('img', { name: /Captured screenshot/ })).toBeVisible();
  await expect(page.locator('.arrow')).toHaveCount(1);   // the drawing survives too

  await page.keyboard.press('Meta+Shift+c');             // and again from the keyboard
  await expect(page.getByRole('img', { name: /Captured screenshot/ })).toBeVisible();
});

test('a moved redaction hides where it lands, not where it came from', async ({ page }) => {
  await page.goto('/');
  await pick(page, 'Redact');
  await drawArrow(page, [200, 560], [420, 630]);         // over blank white card
  const patch = page.locator('.shape image');
  await expect(patch).toHaveCount(1);

  const at = await stage(page);
  const grab = at(310, 595), drop = at(265, 455);        // onto the blue button
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(drop.x, drop.y, { steps: 10 });
  await page.mouse.up();

  const middle = await page.evaluate(async () => {
    const href = document.querySelector('.shape image')!.getAttribute('href')!;
    const image = new Image();
    await new Promise(done => { image.onload = done; image.src = href; });
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const [r, g, b] = context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data;
    return { r, g, b };
  });
  // Blue: resampled where it now sits. A stale patch would still be showing the
  // white it was cut from, which both misleads and leaks the old region.
  expect(middle.b).toBeGreaterThan(180);
  expect(middle.r).toBeLessThan(140);
});

test('crops the capture, brings the drawing along, and can be undone', async ({ page }) => {
  await page.goto('/');
  await drawArrow(page, [300, 300], [600, 400]);
  const drawn = await page.locator('.arrow').getAttribute('d');

  await pick(page, 'Crop');
  await drawArrow(page, [200, 200], [900, 600]);          // drag out the region
  await expect(page.locator('.crop-bar')).toBeVisible();
  await expect(page.locator('.crop-size')).toContainText('700 × 400');

  await page.getByRole('button', { name: /^Crop/ }).click();
  await expect(page.locator('.crop-bar')).toBeHidden();
  await expect(page.locator('.dimensions')).toHaveText('700 × 400 px');
  // The arrow survives, moved to stay over the same part of the picture.
  await expect(page.locator('.arrow')).toHaveCount(1);
  const moved = await page.locator('.arrow').getAttribute('d');
  expect(moved).not.toEqual(drawn);

  await page.keyboard.press('Meta+z');
  await expect(page.locator('.dimensions')).toHaveText('1200 × 740 px');
  expect(await page.locator('.arrow').getAttribute('d')).toEqual(drawn);
});

test('undo takes the drawing before the crop when the drawing came later', async ({ page }) => {
  await page.goto('/');
  await pick(page, 'Crop');
  await drawArrow(page, [200, 200], [900, 600]);
  await page.getByRole('button', { name: /^Crop/ }).click();
  await expect(page.locator('.dimensions')).toHaveText('700 × 400 px');

  await pick(page, 'Arrow');
  await drawArrow(page, [100, 100], [300, 250]);
  await expect(page.locator('.arrow')).toHaveCount(1);

  await page.keyboard.press('Meta+z');                     // the arrow, not the crop
  await expect(page.locator('.arrow')).toHaveCount(0);
  await expect(page.locator('.dimensions')).toHaveText('700 × 400 px');
  await page.keyboard.press('Meta+z');                     // now the crop
  await expect(page.locator('.dimensions')).toHaveText('1200 × 740 px');
});

test('a crop is abandoned by Escape without closing the editor', async ({ page }) => {
  await page.goto('/');
  await pick(page, 'Crop');
  await drawArrow(page, [200, 200], [700, 500]);
  await expect(page.locator('.crop-bar')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.crop-bar')).toBeHidden();
  await expect(page.locator('.dimensions')).toHaveText('1200 × 740 px');
  await expect(page.getByRole('img', { name: /Captured screenshot/ })).toBeVisible();
  // A flick of the mouse is not a crop.
  const at = await stage(page);
  const spot = at(400, 300);
  await page.mouse.click(spot.x, spot.y);
  await expect(page.locator('.crop-bar')).toBeHidden();
});

test('the copied image is the cropped one', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { write: async (items: any[]) => {
      const bitmap = await createImageBitmap(await items[0].getType('image/png'));
      document.body.dataset.copiedSize = `${bitmap.width}x${bitmap.height}`;
    } } });
  });
  await page.goto('/');
  await pick(page, 'Crop');
  await drawArrow(page, [200, 200], [900, 600]);
  await page.getByRole('button', { name: /^Crop/ }).click();
  await page.getByRole('button', { name: /Copy and Close/ }).click();
  // 700x400, not the original 1200x740: a crop forces the re-encode even with
  // nothing drawn, since the untouched original bytes are no longer right.
  await expect(page.locator('body')).toHaveAttribute('data-copied-size', '700x400');
});

test('a redaction is re-sampled after a crop moves it', async ({ page }) => {
  await page.goto('/');
  await pick(page, 'Redact');
  await drawArrow(page, [170, 430], [360, 480]);           // over the blue button
  await pick(page, 'Crop');
  await drawArrow(page, [100, 300], [800, 700]);
  await page.getByRole('button', { name: /^Crop/ }).click();
  // The patch is refilled once the cropped image decodes, not synchronously.
  await expect(page.locator('.shape image')).toHaveCount(1);

  const middle = await page.evaluate(async () => {
    const href = document.querySelector('.shape image')!.getAttribute('href')!;
    const image = new Image();
    await new Promise(done => { image.onload = done; image.src = href; });
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const [r, g, b] = context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data;
    return { r, g, b };
  });
  // Still the button underneath it, read from the cropped image's coordinates.
  expect(middle.b).toBeGreaterThan(180);
  expect(middle.r).toBeLessThan(140);
});

test('a closed capture comes back from Recent, drawing and all', async ({ page }) => {
  await page.goto('/');
  await drawArrow(page, [200, 200], [600, 300]);
  await page.locator('.swatch[data-color="#34c759"]').click();
  const drawn = await page.locator('.arrow').getAttribute('d');

  await page.keyboard.press('Escape');                    // clear the selection
  await page.keyboard.press('Escape');                    // and close
  await expect(page.getByRole('heading', { name: 'Capture a region' })).toBeVisible();
  await expect(page.locator('.recent')).toHaveCount(1);
  await expect(page.locator('.recent')).toContainText('1200 × 740');
  // The thumbnail is a real picture, not a placeholder.
  const thumb = await page.locator('.recent img').getAttribute('src');
  expect(thumb!.startsWith('data:image/png;base64,')).toBe(true);
  expect(thumb!.length).toBeGreaterThan(500);

  await page.locator('.recent').click();
  await expect(page.getByRole('img', { name: /Captured screenshot/ })).toBeVisible();
  await expect(page.locator('.dimensions')).toHaveText('1200 × 740 px');
  // The arrow is back, in the colour it was left in.
  await expect(page.locator('.arrow')).toHaveCount(1);
  await expect(page.locator('.arrow')).toHaveAttribute('fill', '#34c759');
  expect(await page.locator('.arrow').getAttribute('d')).toEqual(drawn);
});

test('a restored capture can still be copied', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { write: async (items: any[]) => {
      const bitmap = await createImageBitmap(await items[0].getType('image/png'));
      document.body.dataset.copiedSize = `${bitmap.width}x${bitmap.height}`;
    } } });
  });
  await page.goto('/');
  await drawArrow(page, [200, 200], [600, 300]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.locator('.recent').click();
  await expect(page.locator('.arrow')).toHaveCount(1);
  await page.getByRole('button', { name: /Copy and Close/ }).click();
  await expect(page.locator('body')).toHaveAttribute('data-copied-size', '1200x740');
});

test('Recent lists the newest capture first', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Escape');                    // close the sample
  await expect(page.locator('.recent')).toHaveCount(1);

  await page.locator('input[type=file]').setInputFiles('src-tauri/icons/128x128.png');
  await expect(page.locator('.dimensions')).toHaveText('128 × 128 px');
  await page.keyboard.press('Escape');

  await expect(page.locator('.recent')).toHaveCount(2);
  await expect(page.locator('.recent').first()).toContainText('128 × 128');
  await expect(page.locator('.recent').nth(1)).toContainText('1200 × 740');
});

test('no Recent section until something has been closed', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.recents')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('.recents')).toBeVisible();
});

test('the capture menu offers the three ways in, and closes again', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.capture-menu')).toBeHidden();
  await page.locator('.capture-more').click();
  await expect(page.locator('.capture-menu')).toBeVisible();
  await expect(page.locator('.capture-menu button')).toHaveText([
    /Region\s*⌃⌥⌘4/, /Whole Screen/, /Timed Region\s*5s/,
  ]);
  await expect(page.locator('.capture-more')).toHaveAttribute('aria-expanded', 'true');

  await page.locator('.titlebar').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.capture-menu')).toBeHidden();
  await expect(page.locator('.capture-more')).toHaveAttribute('aria-expanded', 'false');
  // Capture stays reachable while a capture is already open, which was the point.
  await expect(page.locator('.capture-go')).toBeVisible();
  await expect(page.getByRole('img', { name: /Captured screenshot/ })).toBeVisible();
});

test('zoom scales the capture and the keyboard drives it', async ({ page }) => {
  await page.goto('/');
  const fitted = (await page.locator('.stage').boundingBox())!.width;

  await page.locator('.zoom-select').selectOption('2');
  const doubled = (await page.locator('.stage').boundingBox())!.width;
  expect(Math.round(doubled)).toBe(2400);            // 1200 at 200%
  expect(doubled).toBeGreaterThan(fitted);

  await page.keyboard.press('Meta+0');               // back to Fit
  await expect(page.locator('.zoom-select')).toHaveValue('fit');
  expect(Math.round((await page.locator('.stage').boundingBox())!.width)).toBe(Math.round(fitted));

  await page.keyboard.press('Meta+1');               // actual pixels
  await expect(page.locator('.zoom-select')).toHaveValue('1');
  await page.keyboard.press('Meta+-');               // one stop down
  await expect(page.locator('.zoom-select')).toHaveValue('0.5');
  await page.keyboard.press('Meta+=');               // and back up
  await expect(page.locator('.zoom-select')).toHaveValue('1');
});

test('drawing lands on the same pixels whatever the zoom', async ({ page }) => {
  await page.goto('/');
  await drawArrow(page, [60, 60], [300, 200]);
  const atFit = await page.locator('.arrow').getAttribute('d');
  await page.keyboard.press('Backspace');
  await expect(page.locator('.arrow')).toHaveCount(0);

  await page.locator('.zoom-select').selectOption('2');
  await drawArrow(page, [60, 60], [300, 200]);       // same image coordinates
  const atDouble = await page.locator('.arrow').getAttribute('d');

  // The head of the arrow is its fourth point, and it should sit where the
  // pointer was released -- in image pixels, not screen ones.
  const head = (path: string) => path.split('L')[3].split(/[ Z]/).slice(0, 2).map(Number);
  const [fx, fy] = head(atFit!);
  const [dx, dy] = head(atDouble!);
  expect(Math.abs(fx - 300)).toBeLessThan(3);
  expect(Math.abs(fy - 200)).toBeLessThan(3);
  expect(Math.abs(dx - fx)).toBeLessThan(3);
  expect(Math.abs(dy - fy)).toBeLessThan(3);
});

test('a new capture comes back to Fit', async ({ page }) => {
  await page.goto('/');
  await page.locator('.zoom-select').selectOption('4');
  await expect(page.locator('.zoom-select')).toHaveValue('4');
  await page.locator('input[type=file]').setInputFiles('src-tauri/icons/128x128.png');
  await expect(page.locator('.dimensions')).toHaveText('128 × 128 px');
  await expect(page.locator('.zoom-select')).toHaveValue('fit');
});
