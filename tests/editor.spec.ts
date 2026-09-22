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

test('the size slider goes down to a hairline', async ({ page }) => {
  await page.goto('/');
  await pick(page, 'Box');
  await drawArrow(page, [200, 200], [600, 420]);
  const box = page.locator('.shape rect[stroke="#ff3b30"]');
  const full = Number(await box.getAttribute('stroke-width'));
  await page.locator('.weight').fill('0.1');
  const thin = Number(await box.getAttribute('stroke-width'));
  // A tenth of the capture's base stroke, not the old floor of half. On the
  // 1200x740 sample that is about a pixel and a half.
  expect(thin).toBeCloseTo(full / 10, 1);
  expect(thin).toBeLessThan(2);
  // Fatten a second box, then pick the thin one again: the slider follows it back.
  await drawArrow(page, [700, 100], [900, 300]);
  await page.locator('.weight').fill('2.5');
  await expect(page.locator('.shape rect[stroke="#ff3b30"]')).toHaveCount(2);
  const at = await stage(page);
  const edge = at(200, 310);
  await page.mouse.click(edge.x, edge.y);
  await expect(page.locator('.weight')).toHaveValue('0.1');
});

test('no tool, colour or control is ever clipped out of reach, at any width', async ({ page }) => {
  await page.goto('/');
  // The widest the bar gets: something selected so the label shows, with each
  // picker in turn -- the arrow's has three buttons, the shape's two.
  await pick(page, 'Box');
  await drawArrow(page, [200, 200], [600, 420]);
  await pick(page, 'Arrow');
  await drawArrow(page, [200, 500], [600, 650]);
  const widths = [1200, 875, 760, 740, 720, 700, 660, 640, 620, 600, 580, 560, 540, 520, 500, 480, 460, 440, 420, 400, 380];
  for (const [width, tool] of widths.flatMap(w => [[w, 'Arrow'], [w, 'Box']] as const)) {
    await page.setViewportSize({ width, height: 600 });
    await pick(page, tool);
    // Reselect the drawn item of that kind, so the picker and label are both up.
    const at = await stage(page);
    const spot = tool === 'Box' ? at(200, 310) : at(400, 575);
    await page.mouse.click(spot.x, spot.y);
    const report = await page.evaluate(() => {
      const inside = (el: Element, box: DOMRect) => {
        const r = el.getBoundingClientRect();
        return r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
      };
      const shown = (el: Element) => (el as HTMLElement).offsetParent !== null;
      const bar = document.querySelector('.toolbar')!, rail = document.querySelector('.rail')!;
      const barBox = bar.getBoundingClientRect(), railBox = rail.getBoundingClientRect();
      return {
        barOverflow: bar.scrollWidth - bar.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        // Anything displayed must be wholly inside its container: hidden by a
        // breakpoint is fine, cut off by an edge is not.
        clippedInBar: [...bar.querySelectorAll('button, .size')].filter(el => shown(el) && !inside(el, barBox)).map(el => el.getAttribute('aria-label') || el.getAttribute('title') || el.className),
        tools: [...rail.querySelectorAll('.tool')].filter(el => inside(el, railBox)).length,
        swatches: [...bar.querySelectorAll('.swatch')].filter(el => shown(el) && inside(el, barBox)).length,
        size: shown(bar.querySelector('.weight')!),
        picker: shown(bar.querySelector('.fills')!) || shown(bar.querySelector('.styles')!),
      };
    });
    expect(report, `${width}px, ${tool}`).toMatchObject({ barOverflow: 0, pageOverflow: 0, clippedInBar: [], tools: 10, swatches: 8, size: true, picker: true });
  }
});

test('the active-tool pill is under the tool from the first frame, and after reopening', async ({ page }) => {
  const misplaced = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.lens')].filter(l => !l.hidden).flatMap(l => {
    const a = l.parentElement!.querySelector('[aria-checked="true"]')!;
    const lr = l.getBoundingClientRect(), ar = a.getBoundingClientRect();
    const off = Math.abs(lr.left - ar.left) > 1 || Math.abs(lr.top - ar.top) > 1 || Math.abs(lr.width - ar.width) > 1;
    return off ? [`${l.parentElement!.className}: pill at ${Math.round(lr.left)},${Math.round(lr.top)} ${Math.round(lr.width)}x${Math.round(lr.height)}, tool at ${Math.round(ar.left)},${Math.round(ar.top)}`] : [];
  }));
  await page.goto('/');
  // No waiting: a pill that is still sliding in from the corner is the bug.
  expect(await misplaced()).toEqual([]);
  expect(await page.locator('.lens:not([hidden])').count()).toBe(2);   // the rail and the arrow picker
  // Out to the empty state and back: the rail was display: none in between,
  // and the pill must not slide from wherever it was before.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Capture a region' })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles('src-tauri/icons/128x128.png');
  await expect(page.getByText('128 × 128 px')).toBeVisible();
  expect(await misplaced()).toEqual([]);
});

test('a shape can be drawn solid, or filled in afterwards', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.fills')).toBeHidden();             // arrow tool: nothing to fill
  await pick(page, 'Box');
  await expect(page.locator('.fills')).toBeVisible();
  await expect(page.locator('.fills')).toHaveAttribute('data-shape', 'box');

  // Drawn as an outline, then filled in.
  await drawArrow(page, [200, 200], [600, 420]);
  const box = page.locator('.shape rect[stroke="#ff3b30"]');
  await expect(box).toHaveCount(1);
  await page.locator('.style[data-fill="solid"]').click();
  await expect(page.locator('.shape rect[stroke="#ff3b30"]')).toHaveCount(0);
  const solid = page.locator('.shape rect[fill="#ff3b30"]');
  await expect(solid).toHaveCount(1);
  await expect(page.locator('.style[data-fill="solid"]')).toHaveAttribute('aria-checked', 'true');

  // The next ellipse is drawn solid from the start, and the picker shows an ellipse.
  await pick(page, 'Ellipse');
  await expect(page.locator('.fills')).toHaveAttribute('data-shape', 'ellipse');
  await drawArrow(page, [700, 200], [1000, 420]);
  await expect(page.locator('.shape ellipse[fill="#ff3b30"]')).toHaveCount(1);

  // Back to an outline, and undo restores the fill.
  await page.locator('.style[data-fill="outline"]').click();
  await expect(page.locator('.shape ellipse[fill="#ff3b30"]')).toHaveCount(0);
  await expect(page.locator('.shape ellipse[stroke="#ff3b30"]')).toHaveCount(1);
  await page.keyboard.press('Meta+z');
  await expect(page.locator('.shape ellipse[fill="#ff3b30"]')).toHaveCount(1);
});

test('the copied image is solid inside a filled box', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { write: async (items: any[]) => {
      const bitmap = await createImageBitmap(await items[0].getType('image/png'));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      // Sample the centre of the box, where an outline would leave the capture showing.
      const [r, g, b] = context.getImageData(400, 310, 1, 1).data;
      document.body.dataset.centre = `${r},${g},${b}`;
    } } });
  });
  await page.goto('/');
  await pick(page, 'Box');
  await page.locator('.style[data-fill="solid"]').click();
  await drawArrow(page, [200, 200], [600, 420]);
  await page.getByRole('button', { name: /Copy and Close/ }).click();
  await expect(page.locator('body')).toHaveAttribute('data-centre', '255,59,48');
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
    /Region\s*⌘4/, /Whole Screen/, /Timed Region\s*5s/,
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

test('a new capture opens at actual size when it fits', async ({ page }) => {
  await page.goto('/');
  // The 1200x740 sample is bigger than the window, so it arrives fitted.
  await expect(page.locator('.zoom-select')).toHaveValue('fit');
  await page.locator('.zoom-select').selectOption('4');

  await page.locator('input[type=file]').setInputFiles('src-tauri/icons/128x128.png');
  await expect(page.locator('.dimensions')).toHaveText('128 × 128 px');
  // Small enough to show whole, so it opens at 100% rather than fitted or at
  // whatever zoom the last capture was left on.
  await expect(page.locator('.zoom-select')).toHaveValue('1');
  expect(Math.round((await page.locator('.stage').boundingBox())!.width)).toBe(128);
});

/** Ids in draw order: later is painted on top, in the overlay and in export. */
function drawOrder(page: import('@playwright/test').Page) {
  return page.locator('.overlay > [data-item]')
    .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-item')));
}
async function clickAt(page: import('@playwright/test').Page, point: { x: number; y: number }, shift = false) {
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.click(point.x, point.y);
  if (shift) await page.keyboard.up('Shift');
}

test('shift-click gathers several annotations, and they move and restyle together', async ({ page }) => {
  await page.goto('/');
  await drawArrow(page, [200, 200], [500, 200]);
  await drawArrow(page, [200, 400], [500, 400]);
  await expect(page.locator('.chosen')).toHaveText('Arrow selected');

  const at = await stage(page);
  await clickAt(page, at(480, 200), true);                 // add the first one
  await expect(page.locator('.chosen')).toHaveText('2 selected');
  // Two selected means outlines, not handles: a handle would be ambiguous.
  await expect(page.locator('.handle')).toHaveCount(0);
  await expect(page.locator('.note-outline')).toHaveCount(2);

  await page.locator('.swatch[data-color="#34c759"]').click();
  await expect(page.locator('.arrow[fill="#34c759"]')).toHaveCount(2);

  const before = await page.locator('.arrow').evaluateAll(n => n.map(a => a.getAttribute('d')));
  const grab = at(480, 400), drop = at(560, 560);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(drop.x, drop.y, { steps: 10 });
  await page.mouse.up();
  const after = await page.locator('.arrow').evaluateAll(n => n.map(a => a.getAttribute('d')));
  expect(after[0]).not.toEqual(before[0]);                 // both moved, not just the grabbed one
  expect(after[1]).not.toEqual(before[1]);

  await page.keyboard.press('Backspace');
  await expect(page.locator('.arrow')).toHaveCount(0);
});

test('shift-click also takes an annotation back out of the selection', async ({ page }) => {
  await page.goto('/');
  await drawArrow(page, [200, 200], [500, 200]);
  await drawArrow(page, [200, 400], [500, 400]);
  const at = await stage(page);
  await clickAt(page, at(480, 200), true);
  await expect(page.locator('.chosen')).toHaveText('2 selected');
  await clickAt(page, at(480, 200), true);
  await expect(page.locator('.chosen')).toHaveText('Arrow selected');
});

test('Command-A takes everything, Escape lets it go', async ({ page }) => {
  await page.goto('/');
  await drawArrow(page, [200, 200], [500, 200]);
  await pick(page, 'Box');
  await drawArrow(page, [200, 400], [600, 600]);
  await page.keyboard.press('Meta+a');
  await expect(page.locator('.chosen')).toHaveText('2 selected');
  await page.keyboard.press('Escape');
  await expect(page.locator('.chosen')).toBeHidden();
});

test('an annotation buried under a highlighter can be brought back out', async ({ page }) => {
  await page.goto('/');
  await drawArrow(page, [250, 250], [550, 300]);
  await pick(page, 'Highlighter');
  await drawArrow(page, [200, 200], [700, 400]);           // laid over the arrow
  const [arrow, band] = await drawOrder(page);
  expect(await drawOrder(page)).toEqual([arrow, band]);    // the band is on top

  await page.locator('.back').click();                     // send it back
  expect(await drawOrder(page)).toEqual([band, arrow]);
  await page.locator('.front').click();                    // and forward again
  expect(await drawOrder(page)).toEqual([arrow, band]);
  await page.keyboard.press('Meta+BracketLeft');           // same from the keyboard
  expect(await drawOrder(page)).toEqual([band, arrow]);
});

test('a shifted bracket goes straight to the front or the back', async ({ page }) => {
  await page.goto('/');
  await drawArrow(page, [150, 150], [350, 250]);
  await drawArrow(page, [200, 300], [400, 400]);
  await drawArrow(page, [250, 450], [450, 550]);
  const [first, second, third] = await drawOrder(page);

  const at = await stage(page);
  await clickAt(page, at(340, 245));                       // the earliest arrow
  await expect(page.locator('.chosen')).toHaveText('Arrow selected');
  await page.keyboard.press('Meta+Shift+BracketRight');    // straight to the front
  expect(await drawOrder(page)).toEqual([second, third, first]);
  await page.keyboard.press('Meta+Shift+BracketLeft');     // and straight back
  expect(await drawOrder(page)).toEqual([first, second, third]);
});

test('copying a multiple selection pastes all of it', async ({ page }) => {
  await page.goto('/');
  await drawArrow(page, [200, 200], [500, 200]);
  await drawArrow(page, [200, 400], [500, 400]);
  const at = await stage(page);
  await clickAt(page, at(480, 200), true);
  await page.keyboard.press('Meta+c');
  await expect(page.getByRole('status')).toContainText('2 annotations copied');
  await page.keyboard.press('Meta+v');
  await expect(page.locator('.arrow')).toHaveCount(4);
  await expect(page.locator('.chosen')).toHaveText('2 selected');
});

test('the empty state has no footer to act on', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('footer')).toBeVisible();     // a capture is showing
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Capture a region' })).toBeVisible();
  await expect(page.locator('footer')).toBeHidden();
  // And it comes back with the capture.
  await page.locator('.recent').click();
  await expect(page.locator('footer')).toBeVisible();
});

test('draws a line with no arrowhead, and reshapes it by an end', async ({ page }) => {
  await page.goto('/');
  await pick(page, 'Line');
  await drawArrow(page, [200, 250], [700, 400]);
  const line = page.locator('.overlay path[stroke="#ff3b30"]');
  await expect(line).toHaveCount(1);
  await expect(line).toHaveAttribute('fill', 'none');       // stroked, not a filled head
  // One move and one line: no curve, no closed polygon, no head.
  const ends = (d: string) => d.match(/-?[\d.]+/g)!.map(Number);
  expect((await line.getAttribute('d'))!).toMatch(/^M[-\d.]+ [-\d.]+L[-\d.]+ [-\d.]+$/);
  expect(ends((await line.getAttribute('d'))!).map(Math.round)).toEqual([200, 250, 700, 400]);
  await expect(page.locator('.handle')).toHaveCount(2);     // ends, like an arrow

  const at = await stage(page);
  const grip = at(700, 400), pull = at(500, 620);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(pull.x, pull.y, { steps: 8 });
  await page.mouse.up();
  const [x1, y1, x2, y2] = ends((await line.getAttribute('d'))!);
  expect([Math.round(x1), Math.round(y1)]).toEqual([200, 250]);   // the other end stayed
  expect(Math.abs(x2 - 500)).toBeLessThan(3);
  expect(Math.abs(y2 - 620)).toBeLessThan(3);
});

test('draws a freehand stroke that follows the pointer', async ({ page }) => {
  await page.goto('/');
  await pick(page, 'Pen');
  const at = await stage(page);
  const start = at(200, 500);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 12; step++) {
    const point = at(200 + step * 45, 500 - Math.sin(step / 2) * 130);
    await page.mouse.move(point.x, point.y);
  }
  await page.mouse.up();

  const stroke = page.locator('.overlay path[stroke="#ff3b30"]');
  await expect(stroke).toHaveCount(1);
  const d = (await stroke.getAttribute('d'))!;
  expect(d.startsWith('M')).toBe(true);
  expect(d).toContain('Q');                                 // smoothed, not a polyline
  // Thinned on release, so it is not one node per pointermove.
  expect(d.split('Q').length).toBeLessThan(14);
  await expect(page.locator('.handle')).toHaveCount(0);     // no ends to grab
});

test('a stroke moves, restyles and undoes like everything else', async ({ page }) => {
  await page.goto('/');
  await pick(page, 'Pen');
  const at = await stage(page);
  const start = at(300, 300);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step++) await page.mouse.move(...Object.values(at(300 + step * 50, 300 + step * 20)) as [number, number]);
  await page.mouse.up();
  const stroke = page.locator('.overlay path[fill="none"]');
  await expect(stroke).toHaveCount(1);

  await page.locator('.swatch[data-color="#34c759"]').click();
  await expect(stroke).toHaveAttribute('stroke', '#34c759');

  const before = await stroke.getAttribute('d');
  const grab = at(500, 380), drop = at(560, 560);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(drop.x, drop.y, { steps: 8 });
  await page.mouse.up();
  expect(await stroke.getAttribute('d')).not.toEqual(before);

  await page.keyboard.press('Meta+z');
  await expect(stroke).toHaveAttribute('d', before!);
});

test('a tap with the pen leaves nothing behind', async ({ page }) => {
  await page.goto('/');
  await pick(page, 'Pen');
  const at = await stage(page);
  const spot = at(400, 300);
  await page.mouse.click(spot.x, spot.y);
  await expect(page.locator('.overlay path[fill="none"]')).toHaveCount(0);
});

test('arrow styles change the shape, and the picker only shows when it applies', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.styles')).toBeVisible();          // the arrow tool is selected
  await pick(page, 'Box');
  await expect(page.locator('.styles')).toBeHidden();           // nothing it could change
  await pick(page, 'Arrow');

  await drawArrow(page, [200, 200], [600, 320]);
  const arrow = page.locator('.arrow');
  await expect(arrow).toHaveAttribute('fill', '#ff3b30');       // tapered: a filled shape

  await page.locator('.style[data-style="line"]').click();
  await expect(arrow).toHaveAttribute('fill', 'none');          // thin: stroked instead
  await expect(arrow).toHaveAttribute('stroke', '#ff3b30');
  const thin = await arrow.getAttribute('d');

  await page.locator('.style[data-style="straight"]').click();
  await expect(arrow).toHaveAttribute('fill', '#ff3b30');
  expect(await arrow.getAttribute('d')).not.toEqual(thin);
  await expect(page.locator('.style[data-style="straight"]')).toHaveAttribute('aria-checked', 'true');
});

test('the picker follows the selected arrow, and the next one keeps that style', async ({ page }) => {
  await page.goto('/');
  await page.locator('.style[data-style="line"]').click();
  await drawArrow(page, [200, 200], [600, 320]);
  await expect(page.locator('.arrow')).toHaveAttribute('fill', 'none');

  // A second arrow inherits the chosen style rather than reverting.
  await page.keyboard.press('Escape');
  await drawArrow(page, [200, 500], [600, 620]);
  await expect(page.locator('.arrow[fill="none"]')).toHaveCount(2);

  // Selecting a tapered one moves the picker to it.
  await page.locator('.style[data-style="taper"]').click();
  await expect(page.locator('.style[data-style="taper"]')).toHaveAttribute('aria-checked', 'true');
});

test('the copied image carries the thin style, stroked not filled', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { write: async (items: any[]) => {
      const bitmap = await createImageBitmap(await items[0].getType('image/png'));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      let red = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] === 255 && data[i + 1] === 59 && data[i + 2] === 48) red++;
      }
      document.body.dataset.redPixels = String(red);
    } } });
  });
  await page.goto('/');
  await page.locator('.style[data-style="line"]').click();
  await drawArrow(page, [200, 200], [800, 500]);
  await page.getByRole('button', { name: /Copy and Close/ }).click();
  // Present in the file, and far less ink than a filled arrow of the same span.
  await expect.poll(async () => Number(await page.locator('body').getAttribute('data-red-pixels')))
    .toBeGreaterThan(500);
});

test('numbered steps count up, renumber when one goes, and a drag points with an arrow', async ({ page }) => {
  await page.goto('/');
  await pick(page, 'Step');
  const at = await stage(page);
  const numerals = page.locator('.step text');

  // A click is the whole gesture: no drag, and the badge stays.
  for (const [x, y] of [[300, 200], [600, 200], [900, 200]] as const) {
    const spot = at(x, y);
    await page.mouse.click(spot.x, spot.y);
  }
  await expect(numerals).toHaveText(['1', '2', '3']);
  await expect(page.locator('.step circle')).toHaveCount(3);
  await expect(page.locator('.step path')).toHaveCount(0);      // clicked, so none of them points

  // Deleting the middle one closes the gap rather than leaving a hole.
  const second = at(600, 200);
  await page.mouse.click(second.x, second.y);
  await expect(page.locator('.chosen')).toHaveText('Step selected');
  await page.keyboard.press('Backspace');
  await expect(numerals).toHaveText(['1', '2']);

  // A drag puts the badge where it started and an arrow where it ended.
  await drawArrow(page, [300, 500], [800, 620]);
  await expect(numerals).toHaveText(['1', '2', '3']);
  await expect(page.locator('.step path')).toHaveCount(1);
  await expect(page.locator('.handle')).toHaveCount(1);         // one grip, at the head

  // Undo takes the whole step back, arrow and all.
  await page.keyboard.press('Meta+z');
  await expect(numerals).toHaveText(['1', '2']);
  await expect(page.locator('.step path')).toHaveCount(0);
});

test('a numbered step travels as one, and reaches the copied image', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { write: async (items: any[]) => {
      const bitmap = await createImageBitmap(await items[0].getType('image/png'));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      // Inside the disc but clear of the numeral, which is drawn at its centre.
      // The badge was placed at 300,200 of a 1200x740 shot.
      const [r, g, b] = ctx.getImageData(316, 200, 1, 1).data;
      document.body.dataset.badge = `${r},${g},${b}`;
    } } });
  });
  await page.goto('/');
  await pick(page, 'Step');
  await drawArrow(page, [300, 200], [700, 420]);
  const before = await page.locator('.step path').getAttribute('d');

  // Dragging the badge carries what it points at: the arrow moves, it does not stretch.
  const at = await stage(page);
  const from = at(300, 200), to = at(340, 260);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  const after = await page.locator('.step path').getAttribute('d');
  expect(after).not.toBe(before);
  const length = (d: string) => {
    const n = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    return Math.round(Math.hypot(n[0] - n[6], n[1] - n[7]));       // tail to the far shoulder
  };
  expect(length(after!)).toBe(length(before!));                     // same arrow, new place

  // Put it back over 300,200 and copy: the badge is in the PNG, not only on screen.
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Copy and Close/ }).click();
  await expect(page.locator('body')).toHaveAttribute('data-badge', '255,59,48');
});
