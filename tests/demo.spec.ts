import { test, expect, type Download, type Page } from '@playwright/test';

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
  await expect(editor.getByRole('heading', { name: 'Capture your screen' })).toBeVisible();
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

test('Capture Window picks the window in the picture, and captures all of it', async ({ page }) => {
  const editor = await open(page);
  await page.locator('.tray').click();
  await page.locator('.tray-menu [data-act="window"]').click();
  const overlay = page.frameLocator('.overlay');
  await expect(overlay.locator('.hint')).toHaveText(/^Click a window to capture it/);

  const stage = (await page.locator('.stage').boundingBox())!;
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await expect(overlay.locator('.pick-name')).toHaveText('Dashboard — Overview');
  await page.mouse.click(stage.x + stage.width / 2, stage.y + stage.height / 2);

  await expect(page.locator('.win.editor')).toBeVisible();
  // The window as it is in the 2880 × 1800 picture: 2200 × 1380 of its pixels.
  await expect(editor.locator('.dimensions')).toHaveText('2200 × 1380 px');
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

  await editor.getByRole('button', { name: /^Copy( ⌘C)?$/ }).click();
  await expect(editor.getByRole('status')).toContainText('Copied');
  expect(await page.evaluate(() => (window as any).__copied.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__copied[0])).toBeGreaterThan(1000);   // a real PNG, not an empty blob

  await editor.getByRole('button', { name: /Copy and Close/ }).click();
  await expect(page.locator('.win.editor')).toBeHidden();
  await expect(page.locator('.hint')).toContainText('Closed');
});

test('settings open in the editor from the gear, and the appearance switches every frame and the page', async ({ page }) => {
  const editor = await open(page);
  await editor.getByRole('button', { name: 'Settings' }).click();
  const settings = editor.getByRole('region', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expect(page.locator('.win.settings')).toHaveCount(0);   // not a window of their own
  await expect(settings.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
  await expect(settings.locator('#version-title')).toContainText('web demo');

  await settings.getByRole('radio', { name: 'Light' }).click();
  await expect(settings.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(editor.locator('html')).toHaveAttribute('data-theme', 'light');

  // What the browser cannot do is said, not faked. A click rather than a
  // check: the box is put back at once, which check() can catch half done.
  await settings.locator('.login').click();
  await expect(settings.locator('.login-note')).toContainText('Mac feature');
  await expect(settings.locator('.login')).not.toBeChecked();

  await settings.getByRole('button', { name: 'Back' }).click();
  await expect(settings).toBeHidden();
  await expect(editor.locator('[data-start="region"]')).toBeVisible();
});

test('the menu bar’s Settings… brings the editor forward showing them', async ({ page }) => {
  const editor = await open(page);
  await page.locator('.win.editor .light.close').click();
  await expect(page.locator('.win.editor')).toBeHidden();
  await page.locator('.tray').click();
  await page.locator('.tray-menu [data-act="settings"]').click();
  await expect(page.locator('.win.editor')).toBeVisible();
  await expect(editor.getByRole('region', { name: 'Settings' })).toBeVisible();
});

test('a timed shot counts down in the menu bar and in the app’s disc over what it will take, gone before the shutter', async ({ page }) => {
  await page.goto('/demo.html');
  const editor = page.frameLocator('.win.editor iframe');
  await editor.getByRole('button', { name: /^Timed/ }).first().click();
  const overlay = page.frameLocator('iframe.overlay');
  await overlay.locator('.veil').waitFor();
  const stage = (await page.locator('.stage').boundingBox())!;
  await page.mouse.move(stage.x + 300, stage.y + 150); await page.mouse.down();
  await page.mouse.move(stage.x + 800, stage.y + 450, { steps: 6 }); await page.mouse.up();
  await overlay.getByRole('button', { name: 'Capture', exact: true }).click();
  const disc = page.locator('iframe.count-disc');
  await expect(disc).toBeVisible();
  await expect(page.frameLocator('iframe.count-disc').locator('.what')).toHaveText('Screenshot');
  await expect(page.frameLocator('iframe.count-disc').locator('.number')).toHaveText(/^[1-5]$/);
  await expect(page.locator('.countdown')).toHaveText(/^[1-5]$/);
  // Over the middle of what will be taken, and in the way of nothing.
  const box = (await disc.boundingBox())!;
  const scale = stage.width / await page.locator('.stage').evaluate(el => (el as HTMLElement).offsetWidth);
  expect(Math.abs(box.x + box.width / 2 - (stage.x + 550 * scale))).toBeLessThan(3);
  expect(Math.abs(box.y + box.height / 2 - (stage.y + 300 * scale))).toBeLessThan(3);
  expect(await disc.evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none');
  await editor.locator('.capture').waitFor({ timeout: 8000 });
  await expect(disc).toHaveCount(0);
  await expect(page.locator('.countdown')).toBeHidden();
});

test('every setting the demo offers stays as it was left, and Settings fit the window', async ({ page }) => {
  await page.setViewportSize({ width: 1472, height: 960 });
  await page.goto('/demo.html');
  const editor = page.frameLocator('.win.editor iframe');
  await editor.locator('.gear, [aria-label="Settings"]').first().click();
  await expect(editor.locator('.settings-view')).toBeVisible();
  await expect.poll(() => editor.locator('.settings-view').evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  const dock = editor.locator('.dock'), install = editor.locator('.auto-install'), check = editor.locator('.auto-update');
  await dock.click({ force: true });
  await expect(dock).not.toBeChecked();
  await expect(editor.locator('.dock-note')).toBeHidden();
  await install.click({ force: true });
  await expect(install).toBeChecked();
  // Not looking means not installing.
  await check.click({ force: true });
  await expect(check).not.toBeChecked();
  await expect(install).not.toBeChecked();
  await editor.getByRole('tab', { name: 'Recording', exact: true }).click();
  await editor.locator('.record-pointer').selectOption('touch');
  await editor.locator('.record-clicks').selectOption('ripple');
  await editor.locator('.record-zoom').click({ force: true });
  await expect(editor.locator('.record-pointer')).toHaveValue('touch');
  await expect(editor.locator('.record-clicks')).toHaveValue('ripple');
  await expect(editor.locator('.record-zoom')).toBeChecked();
  // Back, the window goes back to the size it was.
  const grown = (await page.locator('.win.editor').boundingBox())!.height;
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await page.locator('.win.editor').boundingBox())!.height).toBeLessThan(grown);
});

/** What the overlay's Record bar starts with, the editor having opened it. */
async function recordBar(page: Page) {
  await page.goto('/demo.html');
  const editor = page.frameLocator('.win.editor iframe');
  await editor.locator('[data-start="record"]').click();
  const overlay = page.frameLocator('iframe.overlay');
  await expect(overlay.locator('.choices')).toBeVisible();
  return { editor, overlay };
}
/** The whole desktop recorded for a moment, with a few clicks on it, and stopped. */
async function recorded(page: Page, seconds = 1500) {
  const { editor, overlay } = await recordBar(page);
  await overlay.getByRole('radio', { name: 'Screen' }).click();
  await overlay.locator('.go').click();
  const bar = page.frameLocator('iframe.recording-bar');
  await expect(bar.locator('.stop')).toBeVisible();
  await page.locator('.spot[title="Last 90 days"]').click();
  await page.waitForTimeout(seconds);
  await bar.locator('.stop').click();
  await expect(editor.locator('.trim')).toBeVisible({ timeout: 15_000 });
  return editor;
}
const fileHead = async (download: Download, count: number) => {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).subarray(0, count);
};

test('Record opens the app’s bar, and everything it sets up is remembered for the next', async ({ page }) => {
  const { overlay } = await recordBar(page);
  await expect(overlay.getByRole('radio')).toHaveText(['Region', 'Window', 'Screen']);
  await expect(overlay.locator('.go')).toBeDisabled();
  // Choosing the screen holds: its own announcement comes back to it, and must not undo it.
  await overlay.getByRole('radio', { name: 'Screen' }).click();
  await page.waitForTimeout(150);
  await expect(overlay.locator('.go')).toBeEnabled();
  await overlay.locator('.look-button').click();
  await overlay.locator('[data-pointer="touch"]').click();
  await overlay.locator('[data-clicks="ripple"]').click();
  await overlay.locator('[data-zoom="on"]').click();
  await expect(overlay.locator('.look-label')).toHaveText('Touch · Ripple · Zoom');
  await overlay.locator('.look-button').click();
  await overlay.locator('.go').click();
  const bar = page.frameLocator('iframe.recording-bar');
  await bar.locator('.discard').click();
  await expect(page.locator('iframe.recording-bar')).toHaveCount(0);
  const editor = page.frameLocator('.win.editor iframe');
  await editor.locator('[data-start="record"]').click();
  await expect(overlay.locator('.look-label')).toHaveText('Touch · Ripple · Zoom');
});

test('recording runs with the app’s bar and a count in the menu bar, what is chosen outlined, and × throws it away', async ({ page }) => {
  const { editor, overlay } = await recordBar(page);
  await overlay.getByRole('radio', { name: 'Region' }).click();
  const stage = (await page.locator('.stage').boundingBox())!;
  await page.mouse.move(stage.x + 300, stage.y + 150); await page.mouse.down();
  await page.mouse.move(stage.x + 800, stage.y + 450, { steps: 6 }); await page.mouse.up();
  await overlay.locator('.go').click();
  const bar = page.locator('iframe.recording-bar');
  await expect(bar).toBeVisible();
  await expect(page.locator('iframe.recording-line')).toBeVisible();
  await expect(page.locator('iframe.overlay')).toHaveCount(0);
  await expect(page.locator('.win.editor')).toBeHidden();
  await expect(page.locator('.countdown')).toHaveText(/^0:0\d$/);
  await expect(bar.contentFrame().locator('.time')).toHaveText(/^0:0\d$/);
  await expect(page.locator('.hint span')).toContainText('Recording this desktop');
  // The menu says how to stop it, and nothing else can start.
  await page.locator('.tray').click();
  await expect(page.locator('.tray-menu [data-act="record"]')).toContainText('Stop Recording');
  await expect(page.locator('.tray-menu [data-act="capture"]')).toBeDisabled();
  await page.locator('.tray').click();
  await bar.contentFrame().locator('.discard').click();
  await expect(bar).toHaveCount(0);
  await expect(page.locator('iframe.recording-line')).toHaveCount(0);
  await expect(page.locator('.countdown')).toBeHidden();
  await expect(editor.getByRole('heading', { name: 'Capture your screen' })).toBeVisible();
  await expect(editor.locator('.trim')).toBeHidden();
  await page.locator('.tray').click();
  await expect(page.locator('.tray-menu [data-act="record"]')).toContainText('Record Video');
});

test('a delayed recording counts down in red before it starts', async ({ page }) => {
  const { overlay } = await recordBar(page);
  await overlay.getByRole('radio', { name: 'Screen' }).click();
  await overlay.locator('.delay').click();
  await overlay.locator('.go').click();
  await expect(page.frameLocator('iframe.count-disc').locator('.what')).toHaveText('Recording');
  await expect(page.locator('iframe.recording-bar')).toHaveCount(0);
  await expect(page.locator('iframe.recording-bar')).toBeVisible({ timeout: 6000 });
  await expect(page.locator('iframe.count-disc')).toHaveCount(0);
  await page.frameLocator('iframe.recording-bar').locator('.discard').click();
});

test('a recording opens in the real editor: a movie that plays, its frames on the strip, and all the tools', async ({ page }) => {
  const editor = await recorded(page);
  const movie = editor.locator('video.movie, video').first();
  await expect.poll(() => movie.evaluate(v => (v as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
  const made = await movie.evaluate(v => ({ duration: (v as HTMLVideoElement).duration, src: (v as HTMLVideoElement).src }));
  expect(made.src).toMatch(/^blob:/);
  expect(made.duration).toBeGreaterThan(1);
  await expect(editor.locator('.strip img').first()).toBeVisible();
  for (const tool of ['.cut-out', '.zoom-in', '.speed', '.frame-toggle', '.pointer-look']) await expect(editor.locator(tool)).toBeVisible();
  // Its window has room for the strip, and the pill teaches a recording.
  await expect(page.locator('.hint span')).toContainText('yellow handles');
  await editor.locator('.play').click();
  await expect.poll(() => movie.evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(0.1);
  await editor.locator('.play').click();
  // Closed, it waits in Recent, and reopens as a recording.
  await page.keyboard.press('Meta+w');
  await page.locator('.tray').click();
  await page.locator('.tray-menu [data-act="show"]').click();
  await editor.locator('.recent').first().click();
  await expect(editor.locator('.trim')).toBeVisible();
  await expect.poll(() => movie.evaluate(v => (v as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
});

test('Save Video writes a real movie, and with nothing changed it is the recording itself', async ({ page }) => {
  const editor = await recorded(page);
  const [saved] = await Promise.all([page.waitForEvent('download'), editor.getByRole('button', { name: /Save Video/ }).first().click()]);
  expect(saved.suggestedFilename()).toMatch(/^Mark \d{4}-\d\d-\d\d at .*\.(mp4|webm)$/);
  const head = await fileHead(saved, 12);
  expect(head.includes('ftyp') || head[0] === 0x1a).toBe(true);
  await expect(editor.locator('.message span')).toContainText('Saved as');
});

test('a copy takes what was drawn, cut and framed, and saves as a GIF too', async ({ page }) => {
  const editor = await recorded(page);
  await expect(editor.locator('.strip img').first()).toBeVisible();
  const box = (await editor.locator('.overlay').boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 100); await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 200, { steps: 4 }); await page.mouse.up();
  await page.keyboard.press('Escape');
  await editor.locator('.speed').click();
  await editor.locator('.frame-toggle').click();
  await editor.locator('.frame-panel .devices').getByRole('radio', { name: 'Browser', exact: true }).click();
  await page.keyboard.press('Escape');
  const [movie] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), editor.getByRole('button', { name: /Save Video/ }).first().click()]);
  const head = await fileHead(movie, 12);
  expect(head.includes('ftyp') || head[0] === 0x1a).toBe(true);
  await editor.locator('.save-more').click();
  const [gif] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), editor.getByRole('menuitem', { name: /Save as GIF/ }).click()]);
  expect(gif.suggestedFilename()).toMatch(/\.gif$/);
  expect((await fileHead(gif, 6)).toString()).toBe('GIF89a');
  await expect(editor.locator('.message span')).toContainText(/Saved as .*\.gif/);
});

test('a browser can’t copy a video, so the card holds it to save, and the editor says why', async ({ page }) => {
  const editor = await recorded(page);
  await editor.getByRole('button', { name: /^Copy\b/ }).first().click();
  await expect(editor.locator('.message span')).toContainText('can’t put a video on the clipboard');
  await expect(page.locator('.clip')).toBeVisible();
  await expect(page.locator('.clip-movie')).toBeVisible();
  await expect(page.locator('.clip-image')).toBeHidden();
  await expect(page.locator('.clip-save')).toHaveText('Save Video');
  const [saved] = await Promise.all([page.waitForEvent('download'), page.locator('.clip-save').click()]);
  expect(saved.suggestedFilename()).toMatch(/\.(mp4|webm)$/);
});

test('the dashboard in the desktop answers its clicks, and what is taken is what it shows', async ({ page }) => {
  await page.goto('/demo.html');
  const editor = page.frameLocator('.win.editor iframe');
  await editor.getByRole('heading', { name: 'Capture your screen' }).waitFor();
  await page.keyboard.press('Meta+w');
  const pixels = async () => page.evaluate(async () => {
    const host = (window as unknown as { __markDemo: { invoke(c: string, a: object, f: Window, l: string): Promise<unknown> } }).__markDemo;
    await host.invoke('capture_display', { delay: 0 }, window, 'page');
    const { capture } = await host.invoke('current_capture', {}, window, 'page') as { capture: { dataUrl: string } };
    await host.invoke('dismiss_editor', {}, window, 'page');
    return capture.dataUrl.length;
  });
  const before = await pixels();
  await page.locator('.spot[title="Orders"]').click();
  await expect(page.locator('.scene')).toHaveAttribute('src', /scene-orders/);
  // No range to pick on Orders.
  await expect(page.locator('.spot[title="Last 90 days"]')).toBeHidden();
  expect(await pixels()).not.toBe(before);
  await page.locator('.spot[title="Overview"]').click();
  await expect(page.locator('.spot[title="Last 90 days"]')).toBeVisible();
  await page.locator('.spot[title="Last 90 days"]').click();
  await expect(page.locator('.scene')).toHaveAttribute('src', /scene-90d/);
});

test('a browser that can’t make a movie says so, and the app’s Record stays out of its way', async ({ page }) => {
  await page.addInitScript(() => { delete (window as { MediaRecorder?: unknown }).MediaRecorder; });
  await page.goto('/demo.html');
  const editor = page.frameLocator('.win.editor iframe');
  await editor.getByRole('heading', { name: 'Capture your screen' }).waitFor();
  await expect(editor.locator('[data-start="record"]')).toBeHidden();
  await page.locator('.tray').click();
  await page.locator('.tray-menu [data-act="record"]').click();
  await expect(page.locator('.hint span')).toContainText('can’t record a video');
  await expect(page.locator('iframe.overlay')).toHaveCount(0);
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
  const settings = editor.getByRole('region', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'Capture' }).click();
  await settings.locator('.recorder[data-way="region"]').click();
  await page.keyboard.press('Meta+Shift+m');
  await expect(settings.locator('.recorder[data-way="region"] kbd')).toHaveText('⇧⌘M');
  await expect(editor.locator('.start kbd')).toHaveText('⇧⌘M');            // the editor followed
  await expect(page.locator('.tray-menu [data-act="capture"] kbd')).toHaveText('⇧⌘M');

  // A shortcut of its own for a window opens the overlay already picking one.
  await settings.locator('.recorder[data-way="window"]').click();
  await page.keyboard.press('Meta+Alt+5');
  await expect(settings.locator('.recorder[data-way="window"] kbd')).toHaveText('⌥⌘5');
  await expect(page.locator('.tray-menu [data-act="window"] kbd')).toHaveText('⌥⌘5');
  await settings.getByRole('button', { name: 'Back' }).click();
  await page.locator('.caption').click();
  await page.keyboard.press('Meta+Alt+5');
  await expect(page.frameLocator('.overlay').locator('.hint')).toHaveText(/^Click a window to capture it/);
});

test('a copy shows the very image that was copied, and offers it as a file', async ({ page }) => {
  const editor = await open(page);
  await startSelection(page);
  const stage = (await page.locator('.stage').boundingBox())!;
  await page.mouse.move(stage.x + 300, stage.y + 200); await page.mouse.down(); await page.mouse.move(stage.x + 700, stage.y + 420, { steps: 8 }); await page.mouse.up();
  await page.frameLocator('.overlay').getByRole('button', { name: 'Capture', exact: true }).click();
  await expect(page.locator('.win.editor')).toBeVisible();
  await expect(page.locator('.clip')).toBeHidden();               // nothing copied yet

  const image = (await editor.locator('.overlay').boundingBox())!;
  await page.mouse.move(image.x + image.width * .2, image.y + image.height * .7); await page.mouse.down();
  await page.mouse.move(image.x + image.width * .7, image.y + image.height * .3, { steps: 8 }); await page.mouse.up();
  await editor.getByRole('button', { name: /^Copy( ⌘C)?$/ }).click();
  const clip = page.locator('.clip');
  await expect(clip).toBeVisible();
  await expect(clip.locator('strong')).toHaveText('On your clipboard');
  await expect(clip.locator('.clip-image')).toHaveAttribute('src', /^data:image\/png;base64,/);
  // The stage's 400 x 220 points, drawn at 2880 for the stage's width.
  const scale = 2880 / stage.width;
  await expect(clip.locator('.clip-meta')).toHaveText(`${Math.round(400 * scale)} × ${Math.round(220 * scale)} px`);
  await expect(page.locator('.win.editor')).toBeVisible();        // a plain Copy leaves the editor open
  await page.waitForTimeout(600);                                  // the card's entrance
  await page.screenshot({ path: 'test-results/demo-copied.png' });

  const saving = page.waitForEvent('download');
  await clip.getByRole('button', { name: 'Save PNG' }).click();
  expect((await saving).suggestedFilename()).toMatch(/^Mark \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}\.png$/);

  await clip.getByRole('button', { name: 'Dismiss' }).click();
  await expect(clip).toBeHidden();
  // The next selection clears the desktop of it, so it cannot end up in a capture.
  await editor.getByRole('button', { name: /^Copy( ⌘C)?$/ }).click();
  await expect(clip).toBeVisible();
  await startSelection(page);
  await expect(clip).toBeHidden();
});

test('a browser that refuses the clipboard is told so, and the card offers the file instead', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { write: async () => { throw new DOMException('denied', 'NotAllowedError'); } } });
  });
  await page.goto('/demo.html');
  const editor = page.frameLocator('.win.editor iframe');
  await expect(editor.getByRole('heading', { name: 'Capture your screen' })).toBeVisible();
  await startSelection(page);
  const stage = (await page.locator('.stage').boundingBox())!;
  await page.mouse.move(stage.x + 300, stage.y + 200); await page.mouse.down(); await page.mouse.move(stage.x + 600, stage.y + 350, { steps: 8 }); await page.mouse.up();
  await page.frameLocator('.overlay').getByRole('button', { name: 'Capture', exact: true }).click();
  await editor.getByRole('button', { name: /Copy and Close/ }).click();
  await expect(page.locator('.clip strong')).toHaveText('The browser refused the copy');
  await expect(page.locator('.clip')).toHaveClass(/refused/);
  await expect(page.locator('.win.editor')).toBeVisible();        // not closed: nothing was copied
  await expect(editor.getByRole('status')).toContainText('Save the image instead');
});

test('with a capture open the pill teaches, and stops when the capture closes', async ({ page }) => {
  const editor = await open(page);
  await expect(page.locator('.hint')).toContainText('Click the Mark icon');
  await startSelection(page);
  await expect(page.locator('.hint')).toBeHidden();               // nothing over the desktop while selecting
  const stage = (await page.locator('.stage').boundingBox())!;
  await page.mouse.move(stage.x + 300, stage.y + 200); await page.mouse.down(); await page.mouse.move(stage.x + 600, stage.y + 350, { steps: 8 }); await page.mouse.up();
  await page.frameLocator('.overlay').getByRole('button', { name: 'Capture', exact: true }).click();
  await expect(page.locator('.hint')).toBeVisible();
  await expect(page.locator('.hint')).toHaveAttribute('data-tip', '0');
  await expect(page.locator('.hint')).toContainText('Drag to draw');
  await editor.getByRole('button', { name: /Copy and Close/ }).click();
  await expect(page.locator('.hint')).not.toHaveAttribute('data-tip', /./);
  await expect(page.locator('.hint')).toContainText('Closed');
});

test('a phone gets a picture of the editor and none of the frames', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/demo.html');
  await expect(page.locator('.poster img')).toBeVisible();
  await expect(page.locator('.poster figcaption')).toContainText('open this page on a Mac');
  await expect(page.locator('.stage')).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(await page.locator('.poster img').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  // Turned, or measured too early by a host: the poster gives way to the demo, and never the reverse.
  await page.setViewportSize({ width: 900, height: 600 });
  await expect(page.locator('.stage')).toBeVisible();
  await expect(page.locator('.poster')).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveClass(/poster-page/);
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.locator('.stage')).toHaveCount(1);
});

// Copy in the overlay, as in the app: the clipboard and Recent, and the editor
// back as it was -- on its empty state, since it was open on that before.
test('Copy in the overlay puts the region on the clipboard and in Recent, without opening it', async ({ page }) => {
  const editor = await open(page);
  await startSelection(page);
  const stage = (await page.locator('.stage').boundingBox())!;
  await page.mouse.move(stage.x + 300, stage.y + 200); await page.mouse.down();
  await page.mouse.move(stage.x + 600, stage.y + 350, { steps: 8 }); await page.mouse.up();
  await page.frameLocator('.overlay').getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.locator('.clip strong')).toHaveText('On your clipboard');
  expect(await page.evaluate(() => (window as any).__copied.length)).toBe(1);
  await expect(editor.getByRole('heading', { name: 'Capture your screen' })).toBeVisible();
  await expect(editor.locator('.recent')).toHaveCount(1);
  await expect(editor.locator('.recent')).toContainText('Just now');
});

// The site's "Let an agent ask": the demo plays the AI tool, and the visitor
// answers it with the real editor, request bar, Send and all.
test('Claude asks, the visitor captures and points, and the card shows what Claude received', async ({ page }) => {
  const editor = await open(page);
  await page.evaluate(() => window.postMessage('mark-demo:ask', location.origin));
  const bar = editor.locator('.request-bar');
  await expect(bar).toContainText('Claude asks to see “the chart’s peak”');
  await expect(page.locator('.hint')).toContainText('Claude asked to see the chart’s peak');

  // Capture a region, the usual way.
  await editor.locator('[data-start="region"]').click();
  await expect(page.frameLocator('.overlay').locator('.veil')).toBeVisible();
  const stage = (await page.locator('.stage').boundingBox())!;
  await page.mouse.move(stage.x + 300, stage.y + 200); await page.mouse.down();
  await page.mouse.move(stage.x + 700, stage.y + 420, { steps: 8 }); await page.mouse.up();
  await page.frameLocator('.overlay').getByRole('button', { name: 'Capture', exact: true }).click();
  await expect(editor.locator('.capture')).toBeVisible();
  await expect(bar).toBeVisible();                                   // still asking, over the capture

  // A numbered step, with a note: the arrow slot's numbered way, from its menu.
  await editor.locator('.tool[data-slot="0"]').click({ button: 'right' });
  await editor.locator('.tool-menu button', { hasText: 'Numbered arrow' }).click();
  const box = (await editor.locator('.overlay').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.keyboard.type('the peak');

  await editor.getByRole('button', { name: /^Send to Claude/ }).click();
  const card = page.getByRole('complementary', { name: 'What Claude received' });
  await expect(card).toBeVisible();
  await expect(card.locator('.sent-text')).toContainText("The user's screenshot, captured with Mark at");
  await expect(card.locator('.sent-text')).toContainText('1. a badge at (');
  await expect(card.locator('.sent-text')).toContainText('“the peak”');
  expect(await card.locator('.sent-image').evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator('.win.editor')).toBeHidden();             // put away, as Send does
});

test('Don’t Send tells Claude no and keeps the capture', async ({ page }) => {
  const editor = await open(page);
  await page.evaluate(() => window.postMessage('mark-demo:ask', location.origin));
  await expect(editor.locator('.request-bar')).toBeVisible();
  await editor.getByRole('button', { name: 'Don’t Send' }).click();
  await expect(editor.locator('.request-bar')).toBeHidden();
  await expect(page.locator('.hint')).toContainText('Claude was told no');
});
