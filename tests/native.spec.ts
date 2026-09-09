import { test, expect } from '@playwright/test';
import { installBridge, sent, clear, waitFor } from './bridge';
import { CAPTURE } from './fixture';

/** The wiring between the editor and Rust. In the browser preview none of this
 *  runs -- capture falls back to a file picker and copying goes to the web
 *  clipboard -- so without a stand-in bridge a renamed command or a dropped
 *  argument would only ever show up in the built app. */

test('the editor asks Rust for the current capture and renders it', async ({ page }) => {
  await installBridge(page);
  await page.goto('/');
  await expect(page.locator('.dimensions')).toHaveText(`${CAPTURE.width} × ${CAPTURE.height} px`);
  expect((await sent(page)).map(call => call.cmd)).toContain('current_capture');
  await expect(page.locator('.preview-label')).toBeHidden();   // not the browser path
});

test('each way in sends the capture command it should', async ({ page }) => {
  await installBridge(page);
  await page.goto('/');

  await clear(page);
  await page.locator('.capture-go').click();
  expect(await waitFor(page, 'capture_region')).toMatchObject({ args: {} });

  await clear(page);
  await page.locator('.capture-more').click();
  await page.locator('.capture-menu [data-mode="display"]').click();
  expect(await waitFor(page, 'capture_display')).toMatchObject({ args: {} });

  await clear(page);
  await page.locator('.capture-more').click();
  await page.locator('.capture-menu [data-mode="timed"]').click();
  // The delay has to survive the trip, or Timed Region is just Region.
  expect(await waitFor(page, 'capture_region')).toMatchObject({ args: { delay: 5 } });
});

test('an untouched capture is copied by reference, with closing asked for explicitly', async ({ page }) => {
  await installBridge(page);
  await page.goto('/');

  await clear(page);
  await page.getByRole('button', { name: /^Copy/ }).first().click();
  expect(await waitFor(page, 'copy_capture')).toMatchObject({ args: { close: false } });
  await expect(page.getByRole('img', { name: /Captured screenshot/ })).toBeVisible();

  await clear(page);
  await page.getByRole('button', { name: /Copy and Close/ }).click();
  expect(await waitFor(page, 'copy_capture')).toMatchObject({ args: { close: true } });
  expect((await sent(page)).some(call => call.cmd === 'copy_edited')).toBe(false);
});

test('a drawing switches copying to the flattened path, carrying the image', async ({ page }) => {
  await installBridge(page);
  await page.goto('/');
  const box = (await page.locator('.overlay').boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + box.height - 20, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.arrow')).toHaveCount(1);

  await clear(page);
  await page.getByRole('button', { name: /Copy and Close/ }).click();
  const call = await waitFor(page, 'copy_edited');
  expect(call.args.close).toBe(true);
  // Bare base64, no data: prefix -- Rust decodes it straight.
  const png = call.args.png as string;
  expect(png.startsWith('data:')).toBe(false);
  expect(png.startsWith('iVBORw0KGgo')).toBe(true);
  expect(png.length).toBeGreaterThan(200);
});

test('dismissing and quitting go through Rust', async ({ page }) => {
  await installBridge(page);
  await page.goto('/');
  await page.keyboard.press('Escape');
  await waitFor(page, 'dismiss_editor');
  await page.keyboard.press('Meta+q');
  await waitFor(page, 'quit_app');
});

test('a missing screen grant is reported, and opens the right settings pane', async ({ page }) => {
  await installBridge(page, {
    capture: null,
    error: "Mark needs screen access to capture. Open System Settings to allow it, then reopen Mark.",
  });
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('screen access');
  await page.getByRole('button', { name: 'Open System Settings' }).click();
  await waitFor(page, 'open_screen_settings');
});

test('a command that fails says so instead of failing silently', async ({ page }) => {
  await installBridge(page, { fails: { capture_region: 'The capture shortcut is unavailable.' } });
  await page.goto('/');
  await page.locator('.capture-go').click();
  await expect(page.getByRole('status')).toContainText('unavailable');
});

/** The overlay reports its selection in the global point space screencapture -R
 *  reads, which means adding the origin of the display it is covering. On a
 *  second monitor that origin is not zero, and getting it wrong would capture
 *  the wrong part of the wrong screen. */
async function overlayOn(page: import('@playwright/test').Page,
                         display: { x: number; y: number; width: number; height: number }, delay = 0) {
  await installBridge(page);
  await page.addInitScript(`window.__MARK_DISPLAY__ = ${JSON.stringify({ ...display, scale: 2 })};
                            window.__MARK_DELAY__ = ${delay};`);
  await page.goto('/selector.html');
  await page.waitForSelector('.veil');
}

test('a selection is reported in global points, not window ones', async ({ page }) => {
  await overlayOn(page, { x: 1512, y: -220, width: 2560, height: 1440 });
  await page.mouse.move(100, 80);
  await page.mouse.down();
  await page.mouse.move(500, 380, { steps: 10 });
  await page.mouse.up();

  await clear(page);
  await page.locator('.go').click();
  const call = await waitFor(page, 'capture_rect');
  // The display's own origin has to be added, or a second monitor captures
  // whatever happens to sit at those coordinates on the first.
  expect(call.args).toMatchObject({ x: 1512 + 100, y: -220 + 80, width: 400, height: 300, delay: 0 });
});

test('the armed delay reaches Rust with the rectangle', async ({ page }) => {
  await overlayOn(page, { x: 0, y: 0, width: 1440, height: 900 }, 5);
  await page.mouse.move(60, 60);
  await page.mouse.down();
  await page.mouse.move(360, 260, { steps: 8 });
  await page.mouse.up();
  await clear(page);
  await page.locator('.go').click();
  expect((await waitFor(page, 'capture_rect')).args).toMatchObject({ delay: 5 });
});

test('cancelling tells Rust, and Capture cannot be sent twice', async ({ page }) => {
  await overlayOn(page, { x: 0, y: 0, width: 1440, height: 900 });
  await page.mouse.move(60, 60);
  await page.mouse.down();
  await page.mouse.move(360, 260, { steps: 8 });
  await page.mouse.up();

  await clear(page);
  await page.locator('.go').click();
  await waitFor(page, 'capture_rect');
  // A second press must not start a second capture of the same selection.
  await page.locator('.go').click();
  await page.waitForTimeout(150);
  expect((await sent(page)).filter(call => call.cmd === 'capture_rect')).toHaveLength(1);
});

test('Escape over the overlay cancels through Rust', async ({ page }) => {
  await overlayOn(page, { x: 0, y: 0, width: 1440, height: 900 });
  await page.keyboard.press('Escape');
  await waitFor(page, 'cancel_selection');
});

test('a Retina capture is shown at the size it was taken, not at its pixel count', async ({ page }) => {
  // 480x320 pixels off a 2x display: a 240x160 region of screen.
  await installBridge(page, { capture: { ...CAPTURE, width: 480, height: 320, scale: 2 } });
  await page.goto('/');
  await expect(page.locator('.zoom-select')).toHaveValue('1');
  const box = (await page.locator('.stage').boundingBox())!;
  // 240, not 480: 100% means what was on screen, not one CSS pixel per image pixel.
  expect(Math.round(box.width)).toBe(240);
  expect(Math.round(box.height)).toBe(160);

  await page.locator('.zoom-select').selectOption('2');
  expect(Math.round((await page.locator('.stage').boundingBox())!.width)).toBe(480);
});

test('a capture too big for the window arrives fitted rather than scrolled', async ({ page }) => {
  await installBridge(page, { capture: { ...CAPTURE, width: 5000, height: 3000, scale: 2 } });
  await page.goto('/');
  await expect(page.locator('.zoom-select')).toHaveValue('fit');
  const box = (await page.locator('.stage').boundingBox())!;
  const room = (await page.locator('.canvas').boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(room.width);
  expect(box.height).toBeLessThanOrEqual(room.height);
});

test('saving sends the flattened image and a filename macOS would recognise', async ({ page }) => {
  await installBridge(page, { returns: { save_image: 'Mark 2026-09-09 at 10.35.42.png' } });
  await page.goto('/');
  await clear(page);
  await page.getByRole('button', { name: 'Save to a file' }).click();
  const call = await waitFor(page, 'save_image');

  const png = call.args.png as string;
  expect(png.startsWith('data:')).toBe(false);          // bare base64, as Rust expects
  expect(png.startsWith('iVBORw0KGgo')).toBe(true);
  expect(call.args.name).toMatch(/^Mark \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}\.png$/);
  await expect(page.getByRole('status')).toContainText('Saved as Mark 2026-09-09');
});

test('cancelling the save panel says so rather than claiming success', async ({ page }) => {
  await installBridge(page, { returns: { save_image: null } });
  await page.goto('/');
  // The snapshot arrives asynchronously and the shortcut needs a capture.
  await expect(page.locator('.dimensions')).toContainText('×');
  await page.keyboard.press('Meta+s');
  await waitFor(page, 'save_image');
  await expect(page.getByRole('status')).toContainText('Not saved');
});

test('sharing sends the image too, and the capture stays open', async ({ page }) => {
  await installBridge(page);
  await page.goto('/');
  await expect(page.locator('.dimensions')).toContainText('×');
  await clear(page);
  await page.keyboard.press('Meta+Shift+s');
  const call = await waitFor(page, 'share_image');
  expect((call.args.png as string).startsWith('iVBORw0KGgo')).toBe(true);
  expect(call.args.name).toMatch(/\.png$/);
  // Sharing is not a way out of the editor.
  await expect(page.getByRole('img', { name: /Captured screenshot/ })).toBeVisible();
});

test('a drawing reaches the saved file, not just the clipboard', async ({ page }) => {
  await installBridge(page, { returns: { save_image: 'x.png' } });
  await page.goto('/');
  const box = (await page.locator('.overlay').boundingBox())!;
  await page.mouse.move(box.x + 15, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 15, box.y + box.height - 15, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.arrow')).toHaveCount(1);

  await clear(page);
  await expect(page.locator('.dimensions')).toContainText('×');
  await page.keyboard.press('Meta+s');
  const png = (await waitFor(page, 'save_image')).args.png as string;
  const red = await page.evaluate(async (data) => {
    const image = new Image();
    await new Promise(done => { image.onload = done; image.src = 'data:image/png;base64,' + data; });
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const { data: pixels } = context.getImageData(0, 0, canvas.width, canvas.height);
    let hits = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] === 255 && pixels[i + 1] === 59 && pixels[i + 2] === 48) hits++;
    }
    return hits;
  }, png);
  expect(red).toBeGreaterThan(100);                     // the arrow is in the file
});

test('save and share are not offered in the browser preview', async ({ page }) => {
  await page.goto('/');                                  // no bridge: the web path
  await expect(page.locator('.save')).toBeHidden();
  await expect(page.locator('.share')).toBeHidden();
  await expect(page.getByRole('button', { name: /Copy and Close/ })).toBeVisible();
});
