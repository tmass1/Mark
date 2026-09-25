import { test, expect, type Page } from '@playwright/test';

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

/** Take a variant out of a rail slot's menu, the way a tool group is used. */
async function variant(page: import('@playwright/test').Page, slot: number, name: string) {
  await page.locator(`.tool[data-slot="${slot}"]`).click({ button: 'right' });
  await page.locator('.tool-menu button', { hasText: name }).click();
}
/** The arrow slot wearing its numbered variant, which is what used to be a tool. */
async function numbering(page: import('@playwright/test').Page) {
  await variant(page, 0, 'Numbered arrow');
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
  test.setTimeout(120_000);
  await page.goto('/');
  // The widest the bar gets: something selected so the label shows, with each
  // picker in turn -- the arrow's has three buttons and the looks button, the
  // shape's two. And the two states that used to show both pickers at once and
  // push Delete off the end: a box selected under the arrow tool, and a mixed
  // selection, which now show the pickers for the last thing selected.
  await pick(page, 'Box');
  await drawArrow(page, [200, 200], [600, 420]);
  await pick(page, 'Arrow');
  await drawArrow(page, [200, 500], [600, 650]);
  const widths = [1200, 875, 861, 860, 845, 820, 801, 800, 790, 780, 771, 770, 760, 740, 720, 700, 660, 640,
                  620, 600, 580, 560, 540, 520, 500, 480, 460, 440, 420, 400, 380];
  const states = ['Arrow', 'Box', 'box under the arrow tool', 'everything'] as const;
  for (const [width, state] of widths.flatMap(w => states.map(state => [w, state] as const))) {
    await page.setViewportSize({ width, height: 600 });
    await pick(page, state === 'Box' ? 'Box' : 'Arrow');
    // Reselect the drawn item of that kind, so the picker and label are both up.
    const at = await stage(page);
    if (state === 'everything') await page.keyboard.press('Meta+a');
    else {
      const spot = state === 'Arrow' ? at(400, 575) : at(200, 310);
      await page.mouse.click(spot.x, spot.y);
    }
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
    expect(report, `${width}px, ${state}`).toMatchObject({ barOverflow: 0, pageOverflow: 0, clippedInBar: [], tools: 9, swatches: 8, size: true, picker: true });
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

test('duplicates an annotation, and pastes further copies of it', async ({ page }) => {
  await page.goto('/');
  await drawArrow(page, [200, 200], [600, 300]);
  await expect(page.locator('.arrow')).toHaveCount(1);

  // ⌘D is what takes a mark now; ⌘C belongs to the button that closes.
  await page.keyboard.press('Meta+d');
  await expect(page.locator('.arrow')).toHaveCount(2);
  await expect(page.getByRole('img', { name: /Captured screenshot/ })).toBeVisible();

  await page.keyboard.press('Meta+v');
  await expect(page.locator('.arrow')).toHaveCount(3);
  // Pasting again cascades rather than stacking in one spot.
  await page.keyboard.press('Meta+v');
  await expect(page.locator('.arrow')).toHaveCount(4);
  const paths = await page.locator('.arrow').evaluateAll(nodes => nodes.map(n => n.getAttribute('d')));
  expect(new Set(paths).size).toBe(4);
});

test('nothing to paste says which key would have filled the clipboard', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Meta+v');
  await expect(page.getByRole('status')).toContainText('⌘D');
});

// The footer button promises "Copy and Close ⌘C". A fresh mark arrives
// selected, so a ⌘C that took the selection instead broke that promise at the
// one moment it was most likely to be believed.
for (const [what, prepare] of [
  ['with the mark just drawn still selected', async (page: Page) => {
    await expect(page.locator('.handle')).not.toHaveCount(0);
  }],
  ['with nothing selected', async (page: Page) => {
    await page.keyboard.press('Escape');
    await expect(page.locator('.handle')).toHaveCount(0);
  }],
] as const) {
  test(`Command-C copies the image and closes, ${what}`, async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { write: async () => {} } });
    });
    await page.goto('/');
    await drawArrow(page, [200, 200], [600, 300]);
    await prepare(page);
    await page.keyboard.press('Meta+c');
    await expect(page.getByRole('heading', { name: 'Capture a region' })).toBeVisible();
    // What it closed is not lost -- it is waiting in Recent, drawing and all.
    await expect(page.locator('.recent')).toHaveCount(1);
  });
}

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

test('duplicating a multiple selection takes all of it', async ({ page }) => {
  await page.goto('/');
  await drawArrow(page, [200, 200], [500, 200]);
  await drawArrow(page, [200, 400], [500, 400]);
  const at = await stage(page);
  await clickAt(page, at(480, 200), true);
  await expect(page.locator('.chosen')).toHaveText('2 selected');
  await page.keyboard.press('Meta+d');
  await expect(page.locator('.arrow')).toHaveCount(4);
  await expect(page.locator('.chosen')).toHaveText('2 selected');
  // And the pair stays on the clipboard, so ⌘V lays down another two.
  await page.keyboard.press('Meta+v');
  await expect(page.locator('.arrow')).toHaveCount(6);
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
  await numbering(page);
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

  // A drag puts the badge where it started and an arrow where it ended. The
  // panel is a popover, and reaching for the badge above already put it away.
  await expect(page.locator('.steps')).toBeHidden();
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
  await numbering(page);
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

test('a circle can be numbered, and the panel offers somewhere to say what it is for', async ({ page }) => {
  await page.goto('/');
  // The ellipse slot's numbered variant, out of its menu.
  await expect(page.locator('.tool[data-slot="5"]')).toHaveAccessibleName('Ellipse');
  await variant(page, 5, 'Numbered ellipse');

  // Circling something numbers it and opens the panel focused on that row.
  await drawArrow(page, [150, 180], [520, 300]);
  await expect(page.locator('.badge text')).toHaveText(['1']);
  const panel = page.locator('.steps');
  await expect(panel).toBeVisible();
  await expect(page.locator('.step-row')).toHaveCount(1);
  await expect(page.locator('.step-note')).toBeFocused();
  await page.keyboard.type('make the headline sticky');

  await drawArrow(page, [620, 180], [980, 300]);
  await page.keyboard.type('drop this panel');
  await expect(page.locator('.badge text')).toHaveText(['1', '2']);
  await expect(page.locator('.step-chip')).toHaveText(['1', '2']);

  // A step badge joins the same run rather than starting one of its own.
  // Escape puts the panel away first: it floats over the canvas, so a click
  // aimed through it would land on the panel.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await numbering(page);
  const at = await stage(page);
  const spot = at(800, 560);
  await page.mouse.click(spot.x, spot.y);
  await expect(page.locator('.badge text')).toHaveText(['1', '2', '3']);
  // And the panel keeps off the mark it is about: that one is low, so it moves up.
  await expect(panel).toHaveAttribute('data-at', 'top');

  // Deleting the first renumbers the badges and the rows together.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  // On the first circle's own outline: clicking empty canvas with the Step tool
  // in hand would drop a fourth badge rather than select anything.
  const first = at(335, 181);
  await page.mouse.click(first.x, first.y);
  await expect(page.locator('.chosen')).toHaveText('Ellipse selected');
  await page.keyboard.press('Backspace');
  await expect(page.locator('.badge text')).toHaveText(['1', '2']);
  // The footer keeps count and is the way back to a dismissed panel.
  const reopen = page.locator('.steps-toggle');
  await expect(reopen).toContainText('Steps');
  await expect(reopen.locator('.steps-count')).toHaveText('2');
  await reopen.click();
  await expect(panel).toBeVisible();
  await expect(page.locator('.step-chip')).toHaveText(['1', '2']);
  await expect(page.locator('.step-note').first()).toHaveValue('drop this panel');
});

test('the list copies as text, and the words never reach the image', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__text = null;
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (t: string) => { (window as any).__text = t; },
        write: async (items: any[]) => {
          const bitmap = await createImageBitmap(await items[0].getType('image/png'));
          document.body.dataset.copiedSize = `${bitmap.width}x${bitmap.height}`;
        },
      },
    });
  });
  await page.goto('/');
  await variant(page, 5, 'Numbered ellipse');
  await drawArrow(page, [150, 180], [520, 300]);
  await page.keyboard.type('make the headline sticky');
  await drawArrow(page, [620, 180], [980, 300]);
  // Second one left untyped on purpose: it should still take its number.
  await page.keyboard.press('Escape');

  await page.keyboard.press('Meta+Shift+l');
  await expect(page.getByRole('status')).toContainText('2 steps copied as text');
  expect(await page.evaluate(() => (window as any).__text)).toBe('1. make the headline sticky\n2.');

  // The image copy is untouched, and says the list is there to be had.
  await page.getByRole('button', { name: /^Copy/ }).first().click();
  await expect(page.getByRole('status')).toContainText('⌘⇧L copies the 2 steps');
  await expect(page.locator('body')).toHaveAttribute('data-copied-size', '1200x740');
});

test('a badge placed with a click can still be given an arrow afterwards', async ({ page }) => {
  await page.goto('/');
  await numbering(page);
  const at = await stage(page);
  const spot = at(300, 400);
  await page.mouse.click(spot.x, spot.y);
  await expect(page.locator('.step path')).toHaveCount(0);
  await page.keyboard.press('Escape');                       // out of the note field

  // Selected, the badge offers one grip tucked beside it; pulling it makes the arrow.
  await page.mouse.click(spot.x, spot.y);
  await expect(page.locator('.handle')).toHaveCount(1);
  const grip = (await page.locator('.handle').boundingBox())!;
  const head = at(900, 250);
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(head.x, head.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.step path')).toHaveCount(1);

  // And pulling the head back onto the badge takes the arrow off again.
  const back = (await page.locator('.handle').boundingBox())!;
  await page.mouse.move(back.x + back.width / 2, back.y + back.height / 2);
  await page.mouse.down();
  await page.mouse.move(spot.x, spot.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.step path')).toHaveCount(0);
});

test('the notes can be written on the image, and then they are in the copy too', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: {
      writeText: async () => {},
      write: async (items: any[]) => {
        const bitmap = await createImageBitmap(await items[0].getType('image/png'));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        // A band to the right of the badge at 300,400, where the words go.
        const { data } = ctx.getImageData(360, 380, 320, 40);
        let red = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] < 120) red++;
        document.body.dataset.inkRight = String(red);
      },
    } });
  });
  await page.goto('/');
  await numbering(page);
  const at = await stage(page);
  const spot = at(300, 400);
  await page.mouse.click(spot.x, spot.y);
  await page.keyboard.type('make the headline sticky');

  // Off by default: the badge is drawn, the words are not.
  await expect(page.locator('.badge text')).toHaveText(['1']);
  // The footer's own Copy: the panel has a "Copy list" that would match by name.
  // The write is async, so wait for it rather than for the click to return.
  const copyImage = page.locator('footer .copy-only');
  const copy = async () => {
    await page.evaluate(() => { delete document.body.dataset.inkRight; });
    await copyImage.click();
    await expect(page.locator('body')).toHaveAttribute('data-ink-right', /\d+/);
    return Number(await page.locator('body').getAttribute('data-ink-right'));
  };
  const withoutWords = await copy();

  // Copying pressed outside the panel, which put it away; open it again.
  await page.locator('.steps-toggle').click();
  await page.getByRole('radio', { name: 'Beside' }).click();
  // The words go down before the disc, so the badge covers them where they meet.
  await expect(page.locator('.badge text')).toHaveText(['make the headline sticky', '1']);
  const withWords = await copy();
  expect(withWords).toBeGreaterThan(withoutWords + 100);     // the words reached the PNG

  // The list still copies as text whichever way that switch is set.
  await page.keyboard.press('Meta+Shift+l');
  await expect(page.getByRole('status')).toContainText('1 step copied as text');
});

test('the steps panel can be dragged out of the way, and cannot be dragged off the edge', async ({ page }) => {
  await page.goto('/');
  await numbering(page);
  const at = await stage(page);
  const spot = at(300, 400);
  await page.mouse.click(spot.x, spot.y);
  await page.keyboard.type('say this');
  const panel = page.locator('.steps');
  await expect(panel).toBeVisible();

  const grab = (await page.locator('.steps-head').boundingBox())!;
  const before = (await panel.boundingBox())!;
  const from = { x: grab.x + grab.width / 2, y: grab.y + grab.height / 2 };   // the title, not a button
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Right and up: left by that much would meet the rail, which it is kept clear of.
  await page.mouse.move(from.x + 120, from.y - 90, { steps: 10 });
  await page.mouse.up();
  const after = (await panel.boundingBox())!;
  expect(Math.round(after.x - before.x)).toBe(120);
  expect(Math.round(after.y - before.y)).toBe(-90);

  // Moved by hand, it stays put: the flip between top and bottom is a guess,
  // and a guess should not overrule a decision.
  await expect(panel).toHaveAttribute('data-moved', '');
  const low = at(200, 700);
  await page.mouse.click(low.x, low.y);
  await expect(page.locator('.badge text')).toHaveCount(2);
  expect((await panel.boundingBox())!.y).toBe(after.y);

  // And it cannot be dropped somewhere it could never be reached.
  const grabAgain = (await page.locator('.steps-head').boundingBox())!;
  await page.mouse.move(grabAgain.x + grabAgain.width / 2, grabAgain.y + grabAgain.height / 2);
  await page.mouse.down();
  await page.mouse.move(grabAgain.x + 3000, grabAgain.y + 3000, { steps: 10 });
  await page.mouse.up();
  const far = (await panel.boundingBox())!;
  const room = (await page.locator('#app').boundingBox())!;
  expect(far.x + far.width).toBeLessThanOrEqual(room.x + room.width);
  expect(far.y + far.height).toBeLessThanOrEqual(room.y + room.height);
});

test('Return does not close the capture, but still applies a crop that offers it', async ({ page }) => {
  await page.goto('/');
  await drawArrow(page, [200, 200], [600, 300]);
  await page.locator('.canvas').click({ position: { x: 5, y: 5 } });   // nothing focused in particular

  // A stray Return used to copy and close, which is a real loss when what it
  // closed took work.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(page.locator('.stage')).toBeVisible();
  await expect(page.locator('.arrow')).toHaveCount(1);

  // Where the bar offers "Crop ⏎", Return still does it.
  await pick(page, 'Crop');
  await drawArrow(page, [200, 200], [900, 600]);
  await expect(page.locator('.crop-bar')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.crop-bar')).toBeHidden();
  await expect(page.locator('.dimensions')).toHaveText('700 × 400 px');
  await expect(page.locator('.stage')).toBeVisible();
});

test('the arrow tool’s pointer carries the colour and style it will draw with', async ({ page }) => {
  await page.goto('/');
  const cursor = () => page.locator('.canvas .overlay').evaluate(el => getComputedStyle(el).cursor);
  await pick(page, 'Arrow');
  const red = await cursor();
  expect(red).toContain('data:image/svg+xml');
  expect(red).toContain(encodeURIComponent('#ff3b30'));

  await page.locator('.swatch[data-color="#007aff"]').click();
  const blue = await cursor();
  expect(blue).toContain(encodeURIComponent('#007aff'));
  expect(blue).not.toBe(red);

  // The three styles draw three different arrows, so they point three different ways.
  await page.locator('.style[data-style="straight"]').click();
  const straight = await cursor();
  await page.locator('.style[data-style="line"]').click();
  const line = await cursor();
  expect(new Set([blue, straight, line]).size).toBe(3);

  // A tool with nothing of its own to say keeps the plain crosshair.
  await pick(page, 'Box');
  expect(await cursor()).toBe('crosshair');
});

test('the step tool’s pointer carries the badge, its colour and the number coming next', async ({ page }) => {
  await page.goto('/');
  const cursor = async () => {
    const css = await page.locator('.canvas .overlay').evaluate(el => getComputedStyle(el).cursor);
    return decodeURIComponent(css.match(/data:image\/svg\+xml,([^"]+)/)![1]);
  };
  await numbering(page);
  const first = await cursor();
  expect(first).toContain('fill="#ff3b30"');
  expect(first).toContain('>1</text>');
  // White numeral on red, by the same rule the badge itself uses.
  expect(first).toContain('fill="#ffffff"');

  // Yellow takes dark ink, badge and pointer alike.
  await page.locator('.swatch[data-color="#ffcc00"]').click();
  const yellow = await cursor();
  expect(yellow).toContain('fill="#ffcc00"');
  expect(yellow).toContain('fill="#1c1c1e"');

  // The arrow it would draw is on there too, in the style the picker holds.
  await page.locator('.style[data-style="line"]').click();
  const thin = await cursor();
  expect(thin).toContain('stroke-linecap="round"');          // stroked, not filled
  await page.locator('.style[data-style="straight"]').click();
  expect(await cursor()).not.toBe(thin);

  // And the number is the one about to be used.
  const at = await stage(page);
  for (const [x, y] of [[300, 200], [600, 200]] as const) {
    const spot = at(x, y);
    await page.mouse.click(spot.x, spot.y);
    await page.keyboard.press('Escape');
  }
  expect(await cursor()).toContain('>3</text>');
  await expect(page.locator('.badge text')).toHaveText(['1', '2']);
});

test('a step points with whichever arrow the picker holds, and the picker follows the one selected', async ({ page }) => {
  await page.goto('/');
  await numbering(page);
  const styles = page.locator('.styles');
  await expect(styles).toBeVisible();                        // the step points, so the picker is its business

  const at = await stage(page);
  const draw = async (style: string, y: number) => {
    await page.locator(`.style[data-style="${style}"]`).click();
    const a = at(200, y), b = at(700, y - 90);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.press('Escape');
  };
  await draw('taper', 180);
  await draw('straight', 380);
  await draw('line', 580);
  await expect(page.locator('.step path')).toHaveCount(3);

  // Three styles, three different arrows; the thin one is stroked, not filled.
  const paths = await page.locator('.step path').evaluateAll(nodes =>
    nodes.map(n => ({ d: n.getAttribute('d'), fill: n.getAttribute('fill') })));
  expect(new Set(paths.map(p => p.d)).size).toBe(3);
  expect(paths[0].fill).not.toBe('none');
  expect(paths[2].fill).toBe('none');

  // Selecting one adopts its style, so the picker always describes the next edit.
  const second = at(200, 380);
  await page.mouse.click(second.x, second.y);
  await expect(page.locator('.chosen')).toHaveText('Step selected');
  await expect(page.locator('.style[data-style="straight"]')).toHaveAttribute('aria-checked', 'true');

  // And restyling the selection restyles the step's arrow.
  const before = await page.locator('.step path').nth(1).getAttribute('d');
  await page.locator('.style[data-style="line"]').click();
  await expect(page.locator('.step path').nth(1)).toHaveAttribute('fill', 'none');
  expect(await page.locator('.step path').nth(1).getAttribute('d')).not.toBe(before);
});


test('the steps panel says what it is, folds, resizes and clings to a side', async ({ page }) => {
  await page.goto('/');
  await numbering(page);
  const at = await stage(page);
  for (const [x, y, words] of [[250, 200, 'make the headline sticky'], [250, 340, 'this line can go']] as const) {
    const spot = at(x, y);
    await page.mouse.click(spot.x, spot.y);
    await page.keyboard.type(words);
  }
  const panel = page.locator('.steps');

  // It names itself and keeps count, in the panel and in the footer.
  await expect(panel.locator('.steps-title')).toHaveText('Steps');
  await expect(panel.locator('.steps-tally')).toHaveText('2');
  await expect(page.locator('.steps-toggle')).toContainText('Steps');
  await expect(page.locator('.steps-toggle')).toContainText('2');

  // Folded it is a title and nothing else, and narrower for it.
  const open = (await panel.boundingBox())!.width;
  await panel.locator('.steps-fold').click();
  await expect(panel).toHaveAttribute('data-folded', '');
  await expect(panel.locator('.step-rows')).toBeHidden();
  await expect(panel.locator('.steps-foot')).toBeHidden();
  await expect(panel.locator('.steps-title')).toBeVisible();
  expect((await panel.boundingBox())!.width).toBeLessThan(open);

  // Unfolding gives the width back, and placing a mark unfolds it, since a note
  // was asked for and there is nowhere to type one.
  await panel.locator('.steps-fold').click();
  expect((await panel.boundingBox())!.width).toBe(open);
  await panel.locator('.steps-fold').click();
  const third = at(600, 200);
  await page.mouse.click(third.x, third.y);
  await expect(panel).not.toHaveAttribute('data-folded', /.*/);
  await expect(page.locator('.step-note')).toHaveCount(3);

  // The sides take hold of the width.
  const edge = (await panel.locator('.steps-edge[data-edge="right"]').boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + 90, edge.y, { steps: 8 });
  await page.mouse.up();
  // Within a handle's width of the 90 asked for: the grip straddles the edge.
  const widened = (await panel.boundingBox())!.width;
  expect(widened).toBeGreaterThan(open + 75);
  expect(widened).toBeLessThan(open + 95);

  // It stops narrowing where a sentence stops fitting.
  const narrow = (await panel.locator('.steps-edge[data-edge="right"]').boundingBox())!;
  await page.mouse.move(narrow.x + narrow.width / 2, narrow.y + narrow.height / 2);
  await page.mouse.down();
  await page.mouse.move(narrow.x - 2000, narrow.y, { steps: 10 });
  await page.mouse.up();
  expect(Math.round((await panel.boundingBox())!.width)).toBe(250);

  // Dragged near a side it clings to it, and never over the tool rail.
  const head = (await panel.locator('.steps-head').boundingBox())!;
  await page.mouse.move(head.x + 60, head.y + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(0, 200, { steps: 10 });
  await page.mouse.up();
  await expect(panel).toHaveAttribute('data-dock', 'left');
  const rail = (await page.locator('.rail').boundingBox())!;
  expect((await panel.boundingBox())!.x).toBeGreaterThanOrEqual(rail.x + rail.width);

  // And the close button shuts it, with the footer as the way back.
  await panel.locator('.steps-close').click();
  await expect(panel).toBeHidden();
  await page.locator('.steps-toggle').click();
  await expect(panel).toBeVisible();
});


test('anything already drawn says it can be taken hold of', async ({ page }) => {
  await page.goto('/');
  const cursorOf = (sel: string) => page.locator(sel).first().evaluate(el => getComputedStyle(el).cursor);

  await drawArrow(page, [200, 200], [700, 300]);
  await pick(page, 'Box');
  await drawArrow(page, [200, 400], [600, 560]);
  await pick(page, 'Text');
  const at = await stage(page);
  const where = at(900, 200);
  await page.mouse.click(where.x, where.y);
  await page.keyboard.type('note');
  await page.keyboard.press('Escape');
  await numbering(page);
  const badge = at(900, 500);
  await page.mouse.click(badge.x, badge.y);
  await page.keyboard.press('Escape');

  // Pressing one of these selects it rather than drawing, whatever tool is in
  // hand, so the pointer should not go on promising a new mark over an old one.
  for (const kind of ['.arrow', '.shape', '.note', '.step']) {
    expect(await cursorOf(kind), kind).toBe('move');
  }

  // Except while cropping, where a press really does start a crop.
  await pick(page, 'Crop');
  for (const kind of ['.arrow', '.shape', '.note', '.step']) {
    expect(await cursorOf(kind), kind).toBe('crosshair');
  }
});

test('Mark’s own tooltips: none of the system’s, quick once one is up, and placed to suit', async ({ page }) => {
  await page.goto('/');
  // A title would be the browser's tooltip as well, so there are none left.
  expect(await page.locator('#app [title]').count()).toBe(0);
  expect(await page.locator('#app [data-tip]').count()).toBeGreaterThan(20);

  const tip = page.locator('.tip');
  await expect(tip).toBeHidden();

  // The first waits; a tooltip that appears the instant you cross a button is
  // a tooltip in the way.
  await page.getByRole('radio', { name: 'Crop', exact: true }).hover();
  await page.waitForTimeout(120);
  await expect(tip).toBeHidden();
  await expect(tip).toHaveText('Crop');
  await expect(tip).toHaveClass(/\bon\b/);

  // Beside a rail tool, where there is no room above or below.
  const rail = (await page.getByRole('radio', { name: 'Crop', exact: true }).boundingBox())!;
  const beside = (await tip.boundingBox())!;
  expect(beside.x).toBeGreaterThanOrEqual(rail.x + rail.width);
  expect(Math.abs((beside.y + beside.height / 2) - (rail.y + rail.height / 2))).toBeLessThan(3);

  // The next is all but immediate: hesitating again between neighbours is what
  // makes tooltips feel slow.
  await page.getByRole('radio', { name: 'Text', exact: true }).hover();
  await page.waitForTimeout(150);
  await expect(tip).toHaveText('Text');

  // Under a toolbar button, and flipped above one near the foot.
  await page.locator('.undo').hover();
  await expect(tip).toHaveText('Undo (⌘Z)');
  const undo = (await page.locator('.undo').boundingBox())!;
  expect((await tip.boundingBox())!.y).toBeGreaterThan(undo.y + undo.height - 1);
  await page.locator('.copy-only').hover();
  await expect(tip).toHaveText('Copy the image and keep working');
  const copy = (await page.locator('.copy-only').boundingBox())!;
  const above = (await tip.boundingBox())!;
  expect(above.y + above.height).toBeLessThanOrEqual(copy.y + 2);

  // Away from anything, it goes.
  await page.mouse.move(600, 400);
  await expect(tip).toBeHidden();
});

test('the rail’s tools are 36 across in a 44 rail, and all nine still fit the smallest window', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 542 });
  await page.goto('/');
  const sizes = await page.evaluate(() => {
    const tool = document.querySelector<HTMLElement>('.tool')!;
    const group = document.querySelector<HTMLElement>('.tool-group')!;
    const rail = document.querySelector<HTMLElement>('.rail')!;
    const railBox = rail.getBoundingClientRect();
    const inside = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.top >= railBox.top - 1 && r.bottom <= railBox.bottom + 1;
    };
    return {
      button: tool.offsetWidth, glyph: tool.querySelector('svg')!.getBoundingClientRect().width,
      group: group.offsetWidth, rail: rail.offsetWidth,
      shown: [...document.querySelectorAll('.tool')].filter(inside).length,
      overflowY: document.documentElement.scrollHeight - innerHeight,
    };
  });
  expect(sizes).toMatchObject({ button: 36, glyph: 20, group: 44, rail: 44, shown: 9, overflowY: 0 });
});

test('a steps field owns the keys that edit text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => {
    (window as any).__text = null;
    Object.defineProperty(navigator, 'clipboard', { value: {
      writeText: async (t: string) => { (window as any).__text = t; },
      write: async () => { (window as any).__wroteImage = true; },
    } });
  });
  await page.goto('/');
  // An arrow as well as the badge, so a stray ⌘A would say "2 selected".
  // Deselected first: choosing the numbered variant would otherwise convert it,
  // which is what the variant is for.
  await drawArrow(page, [200, 500], [700, 600]);
  await page.keyboard.press('Escape');
  await numbering(page);
  const at = await stage(page);
  const spot = at(300, 300);
  await page.mouse.click(spot.x, spot.y);
  await page.keyboard.type('make the headline sticky');
  const field = page.locator('.step-note').first();

  // ⌘A and ⌘C take the text, not every mark and not the screenshot.
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Meta+c');
  expect(await page.evaluate(() => (window as any).__wroteImage)).toBeFalsy();
  await expect(page.locator('.chosen')).toHaveText('Step selected');   // not "2 selected"

  // ⌘V pastes the clipboard's text. It used to paste an annotation, and having
  // been prevented, never pasted the text at all.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type(' / ');
  await page.keyboard.press('Meta+v');
  await expect(field).toHaveValue('make the headline sticky / make the headline sticky');
  await expect(page.locator('.badge')).toHaveCount(1);      // no annotation was pasted

  // What is typed reaches the list, however it got there.
  await page.keyboard.press('Meta+Shift+l');
  expect(await page.evaluate(() => (window as any).__text))
    .toContain('make the headline sticky / make the headline sticky');

  // ⌘Z undoes the typing rather than the drawing.
  await field.focus();
  await page.keyboard.press('Meta+z');
  expect(await field.inputValue()).not.toBe('make the headline sticky / make the headline sticky');
  await expect(page.locator('.badge')).toHaveCount(1);

  // Escape puts the panel away and leaves the capture alone.
  await page.keyboard.press('Escape');
  await expect(page.locator('.steps')).toBeHidden();
  await expect(page.locator('.stage')).toBeVisible();
});

test('holding shift keeps a line straight', async ({ page }) => {
  await page.goto('/');
  await pick(page, 'Line');
  const at = await stage(page);
  const from = at(200, 300), to = at(800, 340);          // a little off horizontal

  await page.keyboard.down('Shift');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Shift');

  const [x1, y1, x2, y2] = (await page.locator('.arrow').first().getAttribute('d'))!
    .match(/-?\d+(\.\d+)?/g)!.map(Number);
  expect(y2).toBeCloseTo(y1, 6);                          // perfectly level, in the numbers too
  expect(x2).toBeGreaterThan(x1 + 100);                   // and still as long as it was drawn

  // Without shift it goes where the pointer went.
  await page.keyboard.press('Meta+z');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  const free = (await page.locator('.arrow').first().getAttribute('d'))!
    .match(/-?\d+(\.\d+)?/g)!.map(Number);
  expect(free[3]).not.toBeCloseTo(free[1], 1);
});

test('a rail slot holds the ways of drawing one thing, and wears the one chosen', async ({ page }) => {
  await page.goto('/');
  // No switch in the toolbar and no Step tool: the slot carries both.
  await expect(page.getByRole('switch', { name: 'Number them' })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Step', exact: true })).toHaveCount(0);
  // Three slots draw something that can be numbered, and say so in the corner.
  await expect(page.locator('.tool-more')).toHaveCount(3);

  const arrow = page.locator('.tool[data-slot="0"]');
  await expect(arrow).toHaveAccessibleName('Arrow');

  // Plain: a drag draws an arrow, a click leaves nothing.
  await drawArrow(page, [200, 200], [600, 280]);
  await page.keyboard.press('Escape');
  const at = await stage(page);
  const empty = at(900, 200);
  await page.mouse.click(empty.x, empty.y);
  await expect(page.locator('.arrow')).toHaveCount(1);
  await expect(page.locator('.badge')).toHaveCount(0);

  // Right-click opens the slot; the menu says what is in it and which is worn.
  await arrow.click({ button: 'right' });
  const menu = page.locator('.tool-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('button span')).toHaveText(['Arrow', 'Numbered arrow']);
  await expect(menu.locator('button').first()).toHaveAttribute('aria-checked', 'true');
  await menu.locator('button').nth(1).click();
  await expect(menu).toBeHidden();

  // The slot wears it, so the rail says what it will draw.
  await expect(arrow).toHaveAccessibleName('Numbered arrow');
  await drawArrow(page, [200, 400], [600, 480]);
  await page.keyboard.press('Escape');
  const spot = at(900, 400);
  await page.mouse.click(spot.x, spot.y);
  await page.keyboard.press('Escape');
  await expect(page.locator('.badge text')).toHaveText(['1', '2']);
  await expect(page.locator('.step path')).toHaveCount(1);     // one of them points

  // Numbering is still a property, so the variant converts what is selected,
  // and selecting a plain arrow puts the slot back on the plain variant.
  const drawn = at(400, 240);
  await page.mouse.click(drawn.x, drawn.y);
  await expect(page.locator('.chosen')).toHaveText('Arrow selected');
  await expect(arrow).toHaveAccessibleName('Arrow');
  await variant(page, 0, 'Numbered arrow');
  await expect(page.locator('.badge text')).toHaveText(['1', '2', '3']);

  // Every slot that can be numbered has the pair, and the numbers are one run.
  await variant(page, 5, 'Numbered ellipse');
  await drawArrow(page, [700, 550], [1000, 680]);
  await expect(page.locator('.badge text')).toHaveText(['1', '2', '3', '4']);
});

test('a slot menu opens by resting on it, and gets out of the way again', async ({ page }) => {
  await page.goto('/');
  const arrow = page.locator('.tool[data-slot="0"]');
  const menu = page.locator('.tool-menu');
  const tip = page.locator('.tip');

  // Resting opens it, but not at once: running the pointer down the rail to
  // reach the crop should not spray menus.
  await arrow.hover();
  await page.waitForTimeout(150);
  await expect(menu).toBeHidden();
  await expect(menu).toBeVisible({ timeout: 2000 });
  // And no tooltip with it: the menu names every way including the one worn.
  await expect(tip).toBeHidden();

  // The gap between the rail and the menu is bridged, so crossing it holds.
  const box = (await menu.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 30);
  await page.waitForTimeout(300);
  await expect(menu).toBeVisible();

  // Away from both and it goes.
  await page.mouse.move(600, 400);
  await expect(menu).toBeHidden();

  // The keyboard opens it too, since resting is no use without a pointer.
  await arrow.focus();
  await page.keyboard.press('ArrowRight');
  await expect(menu).toBeVisible();
  await expect(menu.locator('button').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(arrow).toBeFocused();

  // A slot with one way has no menu, no marker, and keeps its tooltip.
  await expect(page.locator('.tool[data-slot="1"] .tool-more')).toHaveCount(0);
  await page.locator('.tool[data-slot="1"]').hover();
  await expect(tip).toHaveText('Line');
  await expect(menu).toBeHidden();
});

// ---- numbering keeps to the marks it was chosen for --------------------------------

test('picking up another tool leaves a numbered arrow numbered', async ({ page }) => {
  // It used to be restyled on the way: the rail's click applied the new slot's
  // numbering to whatever was still selected -- and a mark just drawn still is.
  await page.goto('/');
  await numbering(page);
  await drawArrow(page, [300, 300], [600, 420]);
  await expect(page.locator('.step')).toHaveCount(1);
  await pick(page, 'Box');
  await expect(page.locator('.step')).toHaveCount(1);
  await expect(page.locator('.badge text')).toHaveText(['1']);
});

test('restyling a selected step never takes its number, whatever tool is in hand', async ({ page }) => {
  await page.goto('/');
  await numbering(page);
  await drawArrow(page, [300, 300], [600, 420]);
  await pick(page, 'Box');
  // Select the step with the Box tool in hand: the numbering switch in hand is
  // the box's, and a colour change used to apply that too.
  const at = await stage(page);
  await clickAt(page, at(300, 300));
  await expect(page.locator('.chosen')).toHaveText('Step selected');
  await page.getByRole('radio', { name: 'Blue' }).click();
  await expect(page.locator('.step')).toHaveCount(1);
  await expect(page.locator('.step circle')).toHaveAttribute('fill', '#007aff');
});

test('choosing a way of drawing numbers only what that slot draws', async ({ page }) => {
  await page.goto('/');
  await variant(page, 4, 'Numbered box');
  await drawArrow(page, [300, 200], [600, 400]);
  await expect(page.locator('.shape .badge')).toHaveCount(1);
  // Plain Arrow from the arrow slot's menu, with the numbered box still
  // selected: an arrow's numbering is nothing to do with the box.
  await page.locator('.tool[data-slot="0"]').click({ button: 'right' });
  await page.locator('.tool-menu button').filter({ hasText: /^Arrow$/ }).click();
  await expect(page.locator('.shape .badge')).toHaveCount(1);
});

test('a note written on the image follows the typing', async ({ page }) => {
  await page.goto('/');
  await numbering(page);
  const at = await stage(page);
  const spot = at(300, 400);
  await page.mouse.click(spot.x, spot.y);
  await page.getByRole('radio', { name: 'Beside' }).click();
  await page.locator('.step-note').first().click();
  await page.keyboard.type('make the headline sticky');
  // Nothing else redraws the image while you type, so the words have to.
  await expect(page.locator('.badge text')).toHaveText(['make the headline sticky', '1']);
});

// ---- shadow and border -----------------------------------------------------------------

async function looksOn(page: import('@playwright/test').Page, names: string[]) {
  const button = page.getByRole('button', { name: 'Shadow and border' });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  for (const name of names) {
    const row = page.getByRole('menuitemcheckbox', { name });
    if (await row.getAttribute('aria-checked') !== 'true') await row.click();
  }
  await page.keyboard.press('Escape');
}

test('shadow and border come from the toolbar, restyle the selection, and undo one at a time', async ({ page }) => {
  await page.goto('/');
  await drawArrow(page, [200, 200], [500, 300]);          // selected, once drawn
  const button = page.getByRole('button', { name: 'Shadow and border' });
  await button.click();
  const shadow = page.getByRole('menuitemcheckbox', { name: 'Shadow' });
  const border = page.getByRole('menuitemcheckbox', { name: 'Border' });
  await shadow.click();
  await expect(page.locator('.arrow')).toHaveAttribute('filter', /url\(#mark-shadow-/);
  await expect(shadow).toHaveAttribute('aria-checked', 'true');
  await expect(button).toHaveClass(/active/);
  // The menu stays open while they are tried.
  await border.click();
  await expect(page.locator('.overlay .border')).toHaveCount(1);
  // With a border, the border is the arrow's whole outline, so it casts the shadow.
  await expect(page.locator('.overlay .border')).toHaveAttribute('filter', /url\(#mark-shadow-/);
  await expect(page.locator('.arrow')).not.toHaveAttribute('filter', /./);
  // Escape closes the menu and hands focus back to its button.
  await page.keyboard.press('Escape');
  await expect(page.locator('.looks-menu')).toBeHidden();
  await expect(button).toBeFocused();
  // One undo step each.
  await page.keyboard.press('Meta+z');
  await expect(page.locator('.overlay .border')).toHaveCount(0);
  await expect(page.locator('.arrow')).toHaveAttribute('filter', /url/);
  await page.keyboard.press('Meta+z');
  await expect(page.locator('.arrow')).not.toHaveAttribute('filter', /./);
  await expect(button).not.toHaveClass(/active/);
});

test('with nothing selected the looks wait for the next arrow, and stay for the one after', async ({ page }) => {
  await page.goto('/');
  await looksOn(page, ['Border']);
  await drawArrow(page, [200, 200], [500, 300]);
  await drawArrow(page, [200, 450], [500, 550]);
  await expect(page.locator('.overlay .border')).toHaveCount(2);
  await expect(page.locator('.overlay filter')).toHaveCount(0);   // no shadow was asked for
});

test('a copy keeps its looks, and so does a mark that gains its number', async ({ page }) => {
  await page.goto('/');
  await looksOn(page, ['Shadow', 'Border']);
  await drawArrow(page, [200, 200], [500, 300]);
  await page.keyboard.press('Meta+d');
  await expect(page.locator('.overlay .border')).toHaveCount(2);
  // The duplicate is selected; numbering it makes it a step, border and all.
  await numbering(page);
  await expect(page.locator('.step')).toHaveCount(1);
  await expect(page.locator('.step path.border')).toHaveCount(1);
  await expect(page.locator('.step path.border')).toHaveAttribute('filter', /url/);
});

test('a white arrow gets a dark border, since a white one would be no border at all', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('radio', { name: 'White' }).click();
  await looksOn(page, ['Border']);
  await drawArrow(page, [200, 200], [500, 300]);
  await expect(page.locator('.overlay .border')).toHaveAttribute('fill', '#1c1c1e');
});

test('the looks reach the copied image: a white rim for the border, a shade under for the shadow', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: {
      writeText: async () => {},
      write: async (items: any[]) => {
        const bitmap = await createImageBitmap(await items[0].getType('image/png'));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        const { data, width } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
        // Three bands of the grey margin above the card, one arrow in each.
        // The margin is #e9eef2: pure white can only be a border, and darker in
        // every channel can only be a shadow -- red is never either.
        const tally = (x0: number) => {
          let white = 0, shade = 0;
          for (let y = 0; y < 82; y++) for (let x = x0; x < x0 + 260; x++) {
            const i = (y * width + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
            if (r >= 250 && g >= 250 && b >= 250) white++;
            if (r < 225 && g < 230 && b < 234) shade++;
          }
          return `${white}/${shade}`;
        };
        document.body.dataset.looks = [60, 450, 840].map(tally).join(' ');
      },
    } });
  });
  await page.goto('/');
  await drawArrow(page, [90, 40], [290, 40]);
  await page.keyboard.press('Escape');
  await looksOn(page, ['Shadow']);
  await drawArrow(page, [480, 40], [680, 40]);
  await page.keyboard.press('Escape');
  await looksOn(page, ['Border']);
  const shadow = page.getByRole('menuitemcheckbox', { name: 'Shadow' });
  await page.getByRole('button', { name: 'Shadow and border' }).click();
  await shadow.click();                                     // border on its own for the third
  await page.keyboard.press('Escape');
  await drawArrow(page, [870, 40], [1070, 40]);
  await page.keyboard.press('Escape');
  await page.locator('footer .copy-only').click();
  await expect(page.locator('body')).toHaveAttribute('data-looks', /\d/);
  const [plain, shaded, bordered] = (await page.locator('body').getAttribute('data-looks'))!
    .split(' ').map(pair => pair.split('/').map(Number));
  expect(plain).toEqual([0, 0]);
  expect(shaded[0]).toBe(0);
  expect(shaded[1]).toBeGreaterThan(300);
  expect(bordered[0]).toBeGreaterThan(500);
  expect(bordered[1]).toBe(0);
});

// ---- framed notes ------------------------------------------------------------------

test('framed, a note goes in with its number, in one pill the arrow leaves from', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: {
      writeText: async () => {},
      write: async (items: any[]) => {
        const bitmap = await createImageBitmap(await items[0].getType('image/png'));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        const box = JSON.parse(document.body.dataset.pill!);
        const { data } = ctx.getImageData(box.x, box.y, box.width, box.height);
        let red = 0, white = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > 200 && data[i + 1] < 110 && data[i + 2] < 110) red++;
          if (data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245) white++;
        }
        document.body.dataset.inPill = `${red}/${white}/${data.length / 4}`;
      },
    } });
  });
  await page.goto('/');
  await numbering(page);
  await drawArrow(page, [150, 40], [700, 40]);
  await page.keyboard.type('fix');
  await page.getByRole('radio', { name: 'Framed' }).click();
  const pill = page.locator('.step .pill');
  await expect(pill).toHaveCount(1);
  await expect(page.locator('.badge text')).toHaveText(['1 fix']);
  const box = await pill.evaluate(rect => ['x', 'y', 'width', 'height']
    .map(name => Number(rect.getAttribute(name))));
  // The number sits where the badge's would: the pill's left end is the badge.
  expect(Math.abs(box[0] + box[3] / 2 - 150)).toBeLessThan(2);
  // The arrow starts past the pill rather than under it.
  const arrowLeft = await page.locator('.step path:not(.border)').evaluate(path => (path as SVGGraphicsElement).getBBox().x);
  expect(arrowLeft).toBeGreaterThan(box[0] + box[2]);
  // And in the copy: mostly the mark's red, with white words in it.
  await page.evaluate(([x, y, width, height]) => {
    document.body.dataset.pill = JSON.stringify({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
  }, box);
  await page.locator('footer .copy-only').click();
  await expect(page.locator('body')).toHaveAttribute('data-in-pill', /\d/);
  const [red, white, area] = (await page.locator('body').getAttribute('data-in-pill'))!.split('/').map(Number);
  expect(red / area).toBeGreaterThan(0.55);
  expect(white).toBeGreaterThan(40);
});

test('framed, a mark with nothing to say keeps its badge, and a pill stays inside the image', async ({ page }) => {
  await page.goto('/');
  await numbering(page);
  const at = await stage(page);
  const quiet = at(300, 300);
  await page.mouse.click(quiet.x, quiet.y);
  await page.getByRole('radio', { name: 'Framed' }).click();
  await expect(page.locator('.step circle')).toHaveCount(1);
  await expect(page.locator('.step .pill')).toHaveCount(0);
  // Near the right edge the pill slides back in rather than running off.
  const edge = at(1180, 60);
  await page.mouse.click(edge.x, edge.y);
  await page.locator('.step-note').last().click();
  await page.keyboard.type('make this one a good deal bigger');
  const pill = page.locator('.step .pill');
  await expect(pill).toHaveCount(1);
  const right = await pill.evaluate(rect => Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')));
  expect(right).toBeLessThanOrEqual(1200);
});

test('the looks menu and the notes switch stay inside a small window', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 600 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Shadow and border' }).click();
  const menu = await page.locator('.looks-menu').boundingBox();
  expect(menu!.x).toBeGreaterThanOrEqual(0);
  expect(menu!.x + menu!.width).toBeLessThanOrEqual(380);
  await page.keyboard.press('Escape');
  // The steps panel drawn in as narrow as it goes: the foot wraps, never clips.
  await page.setViewportSize({ width: 800, height: 600 });
  await numbering(page);
  const at = await stage(page);
  const spot = at(300, 300);
  await page.mouse.click(spot.x, spot.y);
  await page.locator('.steps').evaluate(panel => { (panel as HTMLElement).style.width = '250px'; });
  const clipped = await page.locator('.steps-foot').evaluate(foot => {
    const box = foot.getBoundingClientRect();
    return [...foot.querySelectorAll('button')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.right > box.right + 1 || r.left < box.left - 1;
    }).map(el => el.textContent);
  });
  expect(clipped).toEqual([]);
});

test('a pill’s words sit in the same place on screen and in the copy', async ({ page }) => {
  // SVG's "central" and a canvas's "middle" are about a tenth of an em apart,
  // which put the words two pixels lower on screen than in the copy. Both are
  // set on the alphabetic baseline now; this holds them together.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: {
      writeText: async () => {},
      write: async (items: any[]) => {
        const bitmap = await createImageBitmap(await items[0].getType('image/png'));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        (window as any).__copied = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
        document.body.dataset.copied = 'yes';
      },
    } });
  });
  await page.goto('/');
  await numbering(page);
  await drawArrow(page, [200, 300], [200, 620]);
  await page.keyboard.type('Lorem Ipsum');
  await page.getByRole('radio', { name: 'Framed' }).click();
  await page.locator('footer .copy-only').click();
  await expect(page.locator('body')).toHaveAttribute('data-copied', 'yes');
  const [onScreen, copied] = await page.evaluate(async () => {
    const svg = document.querySelector('.overlay')!, shot = document.querySelector<HTMLImageElement>('.capture')!;
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="740" viewBox="0 0 1200 740">`
      + `<image href="${shot.src}" width="1200" height="740"/>${svg.innerHTML}</svg>`;
    const raster = new Image();
    raster.src = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
    await raster.decode();
    const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 740;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(raster, 0, 0);
    const pill = document.querySelector('.pill')!;
    const [x, y, width, height] = ['x', 'y', 'width', 'height'].map(name => Math.round(Number(pill.getAttribute(name))));
    /** The centre of the words' white ink inside the pill. */
    const ink = (data: Uint8ClampedArray) => {
      let sx = 0, sy = 0, n = 0;
      for (let py = y + 4; py < y + height - 4; py++) for (let px = x + 4; px < x + width - 4; px++) {
        const i = (py * 1200 + px) * 4;
        if (Math.min(data[i], data[i + 1], data[i + 2]) > 200) { sx += px; sy += py; n++; }
      }
      return [sx / n, sy / n];
    };
    return [ink(ctx.getImageData(0, 0, 1200, 740).data), ink((window as any).__copied.data)];
  });
  // Down the page, the baseline: held to half a pixel. Across, SVG and a canvas
  // put glyphs on the pixel grid a little differently, which moves the ink by
  // up to about a pixel either way without anything being out of place.
  expect(Math.abs(onScreen[1] - copied[1])).toBeLessThan(0.5);
  expect(Math.abs(onScreen[0] - copied[0])).toBeLessThan(1.2);
});
