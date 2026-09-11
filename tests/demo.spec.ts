import { test, expect, type Page } from '@playwright/test';

/** The web demo: Mark's real pages in frames, against the page that plays
 *  lib.rs. These drive the whole thing the way a visitor would -- menu bar,
 *  overlay, editor, settings -- and check what comes out of the host. */

test.use({ viewport: { width: 1200, height: 800 } });   // wide enough that the stage is not scaled, so the maths is plain

/** Start a selection from the menu bar and wait for the overlay to be ready to
 *  receive the pointer; in dev the frame loads its modules on demand. */
async function startSelection(page: Page) {
  await page.locator('.tray').click();
  await page.locator('.tray-menu [data-act="capture"]').click();
  const overlay = page.locator('.overlay');
  await expect(overlay).toBeVisible();
  await expect(page.frameLocator('.overlay').locator('.veil')).toBeVisible();
  return overlay;
}

async function open(page: Page) {
  // Copying goes to the visitor's clipboard; record it instead.
  await page.addInitScript(() => {
    (window as any).__copied = [];
    Object.defineProperty(navigator, 'clipboard', { value: { write: async (items: any[]) => {
      const blob = await items[0].getType('image/png'); (window as any).__copied.push(blob.size);
    } } });
  });
  await page.goto('/demo.html');
  const editor = page.frameLocator('.win.editor iframe');
  await expect(editor.getByRole('heading', { name: 'Capture a region' })).toBeVisible();
  return editor;
}

test('the menu bar starts a real selection, and the capture is cut from the desktop', async ({ page }) => {
  const editor = await open(page);
  await startSelection(page);
  await expect(page.locator('.win.editor')).toBeHidden();           // hidden while selecting, as on the Mac

  const stage = (await page.locator('.stage').boundingBox())!;
  const from = { x: stage.x + 300, y: stage.y + 200 }, to = { x: stage.x + 600, y: stage.y + 350 };
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 8 }); await page.mouse.up();
  const panel = page.frameLocator('.overlay');
  await expect(panel.locator('.panel')).toBeVisible();
  await panel.getByRole('button', { name: 'Capture', exact: true }).click();

  await expect(page.locator('.win.editor')).toBeVisible();
  // 300 x 150 points of a desktop drawn at 2880 px for the stage's width.
  const scale = 2880 / stage.width;
  const expected = `${Math.round(300 * scale)} × ${Math.round(150 * scale)} px`;
  await expect(editor.locator('.dimensions')).toHaveText(expected);
  await expect(editor.locator('.capture')).toBeVisible();
});

test('annotating and copying produce a PNG for the clipboard, and closing returns to the desktop', async ({ page }) => {
  const editor = await open(page);
  await startSelection(page);
  const stage = (await page.locator('.stage').boundingBox())!;
  await page.mouse.move(stage.x + 300, stage.y + 200); await page.mouse.down(); await page.mouse.move(stage.x + 700, stage.y + 420, { steps: 8 }); await page.mouse.up();
  await page.frameLocator('.overlay').getByRole('button', { name: 'Capture', exact: true }).click();
  await expect(page.locator('.win.editor')).toBeVisible();

  const image = (await editor.locator('.overlay').boundingBox())!;
  await page.mouse.move(image.x + image.width * .2, image.y + image.height * .7); await page.mouse.down();
  await page.mouse.move(image.x + image.width * .7, image.y + image.height * .3, { steps: 8 }); await page.mouse.up();
  await expect(editor.locator('.arrow')).toHaveCount(1);

  await editor.getByRole('button', { name: /^Copy/, exact: false }).first().click();
  await expect(editor.getByRole('status')).toContainText('Copied');
  expect(await page.evaluate(() => (window as any).__copied.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__copied[0])).toBeGreaterThan(1000);   // a real PNG, not an empty blob

  await editor.getByRole('button', { name: /Copy and Close/ }).click();
  await expect(page.locator('.win.editor')).toBeHidden();
  await expect(page.locator('.hint')).toContainText('Closed');
});

test('settings open from the gear, and the appearance switches every frame and the page', async ({ page }) => {
  const editor = await open(page);
  await editor.getByRole('button', { name: 'Settings' }).click();
  const win = page.locator('.win.settings');
  await expect(win).toBeVisible();
  const settings = page.frameLocator('.win.settings iframe');
  await expect(settings.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
  await expect(settings.locator('.pref-version')).toContainText('web demo');

  await settings.getByRole('radio', { name: 'Light' }).click();
  await expect(settings.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(editor.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(settings.locator('html')).toHaveAttribute('data-theme', 'light');

  // What the browser cannot do is said, not faked.
  await settings.locator('.login').check();
  await expect(settings.locator('.login-note')).toContainText('Mac feature');
  await expect(settings.locator('.login')).not.toBeChecked();

  await win.locator('.light.close').click();
  await expect(win).toBeHidden();
});

test('⌘4 starts a capture, as in the app, and the shortcut is recordable', async ({ page }) => {
  const editor = await open(page);
  await expect(editor.locator('.start kbd')).toHaveText('⌘4');
  await page.locator('.caption').click();                       // focus the page, not a frame
  await page.keyboard.press('Meta+4');
  await expect(page.locator('.overlay')).toBeVisible();
  await expect(page.frameLocator('.overlay').locator('.veil')).toBeVisible();   // loaded, and so listening
  await page.keyboard.press('Escape');
  await expect(page.locator('.overlay')).toHaveCount(0);
  await expect(page.locator('.win.editor')).toBeVisible();

  await editor.getByRole('button', { name: 'Settings' }).click();
  const settings = page.frameLocator('.win.settings iframe');
  await settings.locator('.recorder').click();
  await page.keyboard.press('Meta+Shift+m');
  await expect(settings.locator('.recorder kbd')).toHaveText('⇧⌘M');
  await expect(editor.locator('.start kbd')).toHaveText('⇧⌘M');            // the editor followed
  await expect(page.locator('.tray-menu [data-act="capture"] kbd')).toHaveText('⇧⌘M');
});
