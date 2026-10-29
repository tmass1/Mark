import { test, expect, type Page } from '@playwright/test';
import { installBridge, emit, sent, clear, waitFor } from './bridge';
import { CAPTURE } from './fixture';

/** Screen recordings, against the real invoke path: the overlay picking what
 *  to record, the bar beside one, and the editor playing, trimming and handing
 *  one on. The movie itself is Rust's -- and Playwright's Chromium plays no
 *  H.264 -- so what is checked is what each page asks Rust to do. */

const VIDEO = { ...CAPTURE, scale: 1, video: { id: 7, path: '/Recordings/7/Mark 2026-10-29 at 09.41.07.mp4', duration: 12, sound: false } };

async function editing(page: Page, options: { request?: boolean } = {}) {
  await installBridge(page, {
    capture: VIDEO,
    request: options.request ? { id: 3, client: 'Claude Code', prompt: 'the chart', mode: 'region' } : null,
    returns: { recording_supported: true, video_frames: [CAPTURE.dataUrl, CAPTURE.dataUrl], save_video: 'Mark 2026-10-29 at 09.41.07.mp4' },
  });
  await page.goto('/');
  await expect(page.locator('.trim')).toBeVisible({ timeout: 15_000 });
}
const commands = async (page: Page) => (await sent(page)).map(call => call.cmd);

/** Drag a trim handle to a share of the way along the strip. */
async function dragEdge(page: Page, edge: 'start' | 'end', share: number) {
  const strip = (await page.locator('.strip').boundingBox())!;
  const handle = (await page.locator(`.edge[data-edge="${edge}"]`).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(strip.x + strip.width * share, strip.y + strip.height / 2, { steps: 4 });
  await page.mouse.up();
}

test('a recording opens in a player with its trim, and the tools to mark it up', async ({ page }) => {
  await editing(page);
  await expect(page.locator('.movie')).toBeVisible();
  await expect(page.locator('.movie')).toHaveAttribute('src', VIDEO.video.path);
  await expect(page.locator('.toolbar')).toBeVisible();
  await expect(page.locator('.rail')).toBeVisible();
  await expect(page.locator('.overlay')).toBeVisible();
  // What a recording goes without: cropping, framing, reading its text, zoom.
  await expect(page.locator('.tool[data-slot="9"]')).toBeHidden();
  await expect(page.locator('.frame-button')).toBeHidden();
  await expect(page.locator('.copy-text')).toBeHidden();
  await expect(page.locator('.zoom')).toBeHidden();
  await expect(page.locator('.save-gif')).toBeVisible();
  await expect(page.locator('.dimensions')).toHaveText(`${CAPTURE.width} × ${CAPTURE.height} px · 0:12`);
  await expect(page.locator('.trim-time')).toHaveText('0:12');
  expect((await waitFor(page, 'video_frames')).args).toEqual({ id: 7, count: 10 });
  await expect(page.locator('.frames img')).toHaveCount(2);
  // The glass under the toolbar and the rail, but not under a crop it hasn't.
  expect([...(await sent(page))].reverse().find(call => call.cmd === 'set_glass')!.args).toEqual({ visible: true, crop: false });
  // C would crop a screenshot; a recording has nothing for it to do.
  await page.keyboard.press('c');
  await expect(page.locator('.crop-bar')).toBeHidden();
});

test('the handles keep part of it, and Copy, Save and Share take that part', async ({ page }) => {
  await editing(page);
  await dragEdge(page, 'end', 0.5);
  await dragEdge(page, 'start', 0.25);
  await expect(page.locator('.trim-time')).toHaveText('0:03 of 0:12');
  await expect(page.locator('.trim')).toHaveClass(/trimmed/);
  await clear(page);

  await page.keyboard.press('Meta+c');
  const copied = (await waitFor(page, 'copy_video')).args as { id: number; start: number; end: number; close: boolean };
  expect(copied.id).toBe(7);
  expect(copied.close).toBe(false);
  expect(copied.start).toBeCloseTo(3, 0);
  expect(copied.end).toBeCloseTo(6, 0);
  await expect(page.locator('.message')).toContainText('Copied the recording');

  await page.locator('.save').click();
  expect((await waitFor(page, 'save_video')).args).toMatchObject({ id: 7, gif: false, name: 'Mark 2026-10-29 at 09.41.07.mp4' });
  await expect(page.locator('.message')).toContainText('Saved as Mark 2026-10-29 at 09.41.07.mp4');
  await clear(page);
  await page.locator('.save-gif').click();
  expect((await waitFor(page, 'save_video')).args).toMatchObject({ id: 7, gif: true, name: 'Mark 2026-10-29 at 09.41.07.gif' });
  await page.locator('.share').click();
  expect((await waitFor(page, 'share_video')).args).toMatchObject({ id: 7 });

  await clear(page);
  await page.keyboard.press('Alt+Meta+c');
  expect((await waitFor(page, 'copy_video')).args).toMatchObject({ id: 7, close: true });
  expect(await commands(page)).not.toContain('copy_capture');
});

test('a handle moves with the arrow keys, and I and O trim to the playhead', async ({ page }) => {
  await editing(page);
  const strip = (await page.locator('.strip').boundingBox())!;
  // A click on the strip moves the playhead there: a quarter of 12 seconds.
  await page.mouse.click(strip.x + strip.width * 0.25, strip.y + strip.height / 2);
  await page.keyboard.press('i');
  await expect(page.locator('.edge[data-edge="start"]')).toHaveAttribute('aria-valuetext', '0:03');
  await page.mouse.click(strip.x + strip.width * 0.75, strip.y + strip.height / 2);
  await page.keyboard.press('o');
  await expect(page.locator('.edge[data-edge="end"]')).toHaveAttribute('aria-valuetext', '0:09');
  await expect(page.locator('.trim-time')).toHaveText('0:06 of 0:12');
  await page.locator('.edge[data-edge="end"]').focus();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(page.locator('.edge[data-edge="end"]')).toHaveAttribute('aria-valuetext', '0:11');
  // Never closer than half a second to the other end.
  for (let i = 0; i < 12; i++) await page.keyboard.press('Shift+ArrowLeft');
  const end = Number(await page.locator('.edge[data-edge="end"]').getAttribute('aria-valuenow'));
  expect(end).toBeCloseTo(3.5, 1);
});

/** Draw an arrow across the stage, from and to shares of its width and height. */
async function arrow(page: Page, from: [number, number], to: [number, number]) {
  const stage = (await page.locator('.stage').boundingBox())!;
  await page.mouse.move(stage.x + stage.width * from[0], stage.y + stage.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width * to[0], stage.y + stage.height * to[1], { steps: 5 });
  await page.mouse.up();
}
/** Move the playhead to a share of the way along the strip. */
async function seek(page: Page, share: number) {
  const strip = (await page.locator('.strip').boundingBox())!;
  await page.mouse.click(strip.x + strip.width * share, strip.y + strip.height / 2);
}

test('a mark drawn on a recording appears from the moment it was drawn at', async ({ page }) => {
  await editing(page);
  await seek(page, 0.25);                                   // 0:03
  await arrow(page, [0.2, 0.2], [0.6, 0.6]);
  await expect(page.locator('.overlay [data-item]')).toHaveCount(1);
  // Selected, the strip says when it appears.
  await expect(page.locator('.mark-at')).toBeVisible();
  expect(await page.locator('.mark-at').getAttribute('data-tip')).toBe('Appears at 0:03: drag to change it');

  await page.keyboard.press('Escape');                      // let it go, then look before and after
  await seek(page, 0.1);
  await expect(page.locator('.overlay [data-item]')).toHaveCount(0);
  await expect(page.locator('.mark-at')).toBeHidden();
  await seek(page, 0.5);
  await expect(page.locator('.overlay [data-item]')).toHaveCount(1);

  // Copied with it: one picture of the marks, from 0:03.
  await clear(page);
  await page.keyboard.press('Meta+c');
  const marks = ((await waitFor(page, 'copy_video')).args as { marks: { overlays: { at: number; png: string }[]; redactions: unknown[] } }).marks;
  expect(marks.overlays).toHaveLength(1);
  expect(marks.overlays[0].at).toBeCloseTo(3, 0);
  expect(marks.overlays[0].png.length).toBeGreaterThan(100);
  expect(marks.redactions).toEqual([]);
});

test('the selected mark’s moment can be dragged along the strip, and undone', async ({ page }) => {
  await editing(page);
  await seek(page, 0.25);
  await arrow(page, [0.3, 0.3], [0.7, 0.4]);
  const flag = (await page.locator('.mark-at').boundingBox())!;
  const strip = (await page.locator('.strip').boundingBox())!;
  await page.mouse.move(flag.x + flag.width / 2, flag.y + 4);
  await page.mouse.down();
  await page.mouse.move(strip.x + strip.width * 0.75, strip.y + 4, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.mark-at')).toHaveAttribute('data-tip', 'Appears at 0:09: drag to change it');
  await page.keyboard.press('Meta+z');
  await expect(page.locator('.mark-at')).toHaveAttribute('data-tip', 'Appears at 0:03: drag to change it');
});

test('a redaction on a recording is pixelated by Rust in every frame, and a mark at each moment is its own picture', async ({ page }) => {
  await editing(page);
  await page.keyboard.press('x');                           // Redact
  await seek(page, 0.5);                                    // 0:06
  await arrow(page, [0.1, 0.1], [0.4, 0.4]);
  await expect(page.locator('.redact-live')).toHaveCount(1);
  await page.keyboard.press('a');
  await seek(page, 0.03);                                   // just past the start handle: 0:00
  await arrow(page, [0.5, 0.5], [0.9, 0.9]);
  await seek(page, 0.75);
  await arrow(page, [0.5, 0.2], [0.9, 0.3]);
  await clear(page);
  await page.locator('.save').click();
  const marks = ((await waitFor(page, 'save_video')).args as {
    marks: { overlays: { at: number }[]; redactions: { at: number; width: number; height: number; block: number }[] } }).marks;
  expect(marks.overlays.map(overlay => Math.round(overlay.at))).toEqual([0, 9]);
  expect(marks.redactions).toHaveLength(1);
  expect(marks.redactions[0].at).toBeCloseTo(6, 0);
  expect(marks.redactions[0].width).toBeGreaterThan(0);
  expect(marks.redactions[0].block).toBeGreaterThanOrEqual(7);
});

test('nothing drawn, nothing sent with it: the movie goes as it was', async ({ page }) => {
  await editing(page);
  await page.keyboard.press('Meta+c');
  expect(((await waitFor(page, 'copy_video')).args as { marks: unknown }).marks).toBeNull();
});

test('a recording closed waits in Recent with its length, and comes back trimmed as it was', async ({ page }) => {
  await editing(page);
  await dragEdge(page, 'end', 0.5);
  await page.keyboard.press('Escape');
  await waitFor(page, 'dismiss_editor');
  const recent = page.locator('.recent').first();
  await expect(recent.locator('.recent-length')).toHaveText('0:06');
  await recent.click();
  await expect(page.locator('.trim-time')).toHaveText('0:06 of 0:12');
  await clear(page);
  await page.keyboard.press('Meta+c');
  const copied = (await waitFor(page, 'copy_video')).args as { start: number; end: number };
  expect(copied.start).toBe(0);
  expect(copied.end).toBeCloseTo(6, 0);
});

test('an ask open over a recording is not answered with it: the primary copies as ever', async ({ page }) => {
  await editing(page, { request: true });
  await expect(page.locator('.copy-label')).toHaveText('Copy and Close');
  await page.locator('.copy').click();
  expect((await waitFor(page, 'copy_video')).args).toMatchObject({ close: true });
  expect(await commands(page)).not.toContain('send_capture');
});

test('Record is a way in on a Mac that can record, but not while an AI tool waits', async ({ page }) => {
  await installBridge(page, { capture: null, returns: { recording_supported: true } });
  await page.goto('/');
  const tile = page.locator('.mode[data-start="record"]');
  await expect(tile).toBeVisible({ timeout: 15_000 });
  await expect(tile).toContainText('Record');
  await tile.click();
  expect((await waitFor(page, 'capture_region')).args).toEqual({ record: true });
});

test('no Record where the Mac cannot, or while an ask waits', async ({ page }) => {
  await installBridge(page, { capture: null, returns: { recording_supported: false } });
  await page.goto('/');
  await expect(page.locator('.mode[data-start="window"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.mode[data-start="record"]')).toBeHidden();

  const asked = await page.context().newPage();
  await installBridge(asked, { capture: null, request: { id: 1, client: 'Claude Code', prompt: 'the error', mode: 'region' },
                               returns: { recording_supported: true } });
  await asked.goto('/');
  await expect(asked.locator('.request-bar')).toBeVisible({ timeout: 15_000 });
  await waitFor(asked, 'recording_supported');
  await expect(asked.locator('.mode[data-start="record"]')).toBeHidden();
});

/** The overlay, opened by Record Video. */
async function picking(page: Page, mic: boolean, mode: 'region' | 'window' = 'region') {
  await installBridge(page);
  await page.addInitScript(([mic, mode]) => {
    const w = window as any;
    w.__MARK_KIND__ = 'video'; w.__MARK_MIC__ = mic; w.__MARK_MODE__ = mode; w.__MARK_DELAY__ = 0; w.__MARK_POINTER__ = null;
    w.__MARK_WINDOWS__ = [{ id: 11, app: 'Safari', title: 'Apple', x: 60, y: 50, width: 400, height: 300 }];
  }, [mic, mode] as const);
  await page.goto('/selector.html');
  await page.waitForSelector('.hint');
}

test('the overlay for a recording offers Record and the microphone, not Copy', async ({ page }) => {
  await picking(page, true);
  await page.getByRole('radio', { name: 'Region' }).click();
  await expect(page.locator('.hint')).toHaveText('Drag to select a region to record · Escape to cancel');
  await expect(page.locator('.choice[aria-checked="true"]')).toHaveText('Region');
  await page.mouse.move(100, 100); await page.mouse.down(); await page.mouse.move(400, 300, { steps: 4 }); await page.mouse.up();
  await expect(page.locator('.go')).toHaveText('Record');
  await expect(page.locator('.copy')).toBeHidden();
  await expect(page.locator('.mic')).toHaveAttribute('aria-pressed', 'true');
  // ⌘C copies a screenshot; there is nothing yet to copy of a recording.
  await page.keyboard.press('Meta+c');
  await page.locator('.mic').click();
  await expect(page.locator('.mic')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Enter');
  const asked = (await waitFor(page, 'capture_rect')).args;
  expect(asked).toMatchObject({ x: 100, y: 100, width: 300, height: 200, delay: 0, copy: false, record: true, mic: false });
  expect((await sent(page)).filter(call => call.cmd === 'capture_rect')).toHaveLength(1);
});

test('Space chooses a window and ⌘A the screen, as they do for a screenshot', async ({ page }) => {
  await picking(page, false);
  await page.keyboard.press('Space');
  await expect(page.getByRole('radio', { name: 'Window' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Space');
  await page.keyboard.press('Meta+a');
  await expect(page.getByRole('radio', { name: 'Screen' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.go')).toBeVisible();

  const fresh = await page.context().newPage();
  await picking(fresh, false);
  await fresh.keyboard.press('Meta+a');
  await expect(fresh.getByRole('radio', { name: 'Screen' })).toHaveAttribute('aria-checked', 'true');
});

test('a window is recorded by a click, ⌘ or not', async ({ page }) => {
  await picking(page, false, 'window');
  await expect(page.locator('.hint')).toHaveText('Click a window to record it · Escape to cancel');
  await expect(page.locator('.choice[aria-checked="true"]')).toHaveText('Window');
  await page.keyboard.down('Meta');
  await page.mouse.click(200, 150);
  await page.keyboard.up('Meta');
  expect((await waitFor(page, 'capture_window')).args).toEqual({ id: 11, delay: 0, copy: false, record: true, mic: false });
});

test('a recording is of a region, a window or the screen, chosen up front', async ({ page }) => {
  await picking(page, false);
  const choice = (name: string) => page.getByRole('radio', { name });
  await expect(page.locator('.choice')).toHaveText(['Region', 'Window', 'Screen']);
  // First the choice, with nothing to aim yet: no crosshair, no guides, and a
  // drag selects nothing.
  await expect(page.locator('.hint')).toHaveText('Choose what to record · Escape to cancel');
  await expect(page.locator('.choice[aria-checked="true"]')).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.body).cursor)).toBe('default');
  await page.mouse.move(100, 100); await page.mouse.down(); await page.mouse.move(400, 300, { steps: 4 }); await page.mouse.up();
  await expect(page.locator('.shot')).toBeHidden();
  await expect(page.locator('.guide-x')).toBeHidden();
  // In the middle of the screen while it is the only thing to do.
  const centred = (await page.locator('.choices').boundingBox())!;
  expect(Math.abs(centred.y + centred.height / 2 - page.viewportSize()!.height / 2)).toBeLessThan(4);

  await choice('Region').click();
  await expect(choice('Region')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.hint')).toHaveText('Drag to select a region to record · Escape to cancel');
  expect(await page.evaluate(() => getComputedStyle(document.body).cursor)).toBe('crosshair');

  // Window: picking windows, as Space would.
  await choice('Window').click();
  await expect(choice('Window')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.hint')).toHaveText('Click a window to record it · Escape to cancel');
  expect(await sent(page)).toEqual([]);                        // pressing a choice records nothing

  // Screen: all of this display, ready to record.
  await choice('Screen').click();
  await expect(choice('Screen')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.go')).toBeVisible();
  // The panel never sits over the choices.
  const panel = (await page.locator('.panel').boundingBox())!;
  const bar = (await page.locator('.choices').boundingBox())!;
  expect(panel.y + panel.height).toBeLessThanOrEqual(bar.y);

  // Region again: back to choosing part of it.
  await choice('Region').click();
  await expect(choice('Region')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.panel')).toBeHidden();

  await choice('Screen').click();
  await page.locator('.go').click();
  const viewport = page.viewportSize()!;
  expect((await waitFor(page, 'capture_rect')).args).toMatchObject({ x: 0, y: 0, width: viewport.width, height: viewport.height, record: true });
});

test('a screenshot\'s overlay has no such choices', async ({ page }) => {
  await installBridge(page);
  await page.goto('/selector.html');
  await page.waitForSelector('.hint');
  await expect(page.locator('.choices')).toHaveCount(0);
});

test('the bar beside a recording counts, warns near the end, and stops it', async ({ page }) => {
  await installBridge(page, { returns: { recording_status: { elapsed: 3, limit: 300, mic: true } } });
  await page.setViewportSize({ width: 232, height: 64 });
  await page.goto('/recording.html');
  await expect(page.locator('.time')).toHaveText('0:03', { timeout: 15_000 });
  await expect(page.locator('.mic')).toBeVisible();
  await emit(page, 'recording-tick', { elapsed: 75, limit: 300, mic: true });
  await expect(page.locator('.time')).toHaveText('1:15');
  await emit(page, 'recording-tick', { elapsed: 280, limit: 300, mic: true });
  await expect(page.locator('.time')).toHaveText('0:20 left');
  await expect(page.locator('.time')).toHaveClass(/ending/);
  // Everything fits the window Rust gives it.
  for (const control of ['.stop', '.discard', '.time']) {
    const box = (await page.locator(control).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(232);
  }
  await page.locator('.stop').click();
  await waitFor(page, 'stop_recording');
  await expect(page.locator('.discard')).toBeDisabled();
  // A new recording in the same bar starts it fresh.
  await emit(page, 'recording-tick', { elapsed: 0, limit: 300, mic: false });
  await expect(page.locator('.mic')).toBeHidden();
  await page.locator('.discard').click();
  await waitFor(page, 'discard_recording');
});

test('the outline is a line and nothing to click', async ({ page }) => {
  await installBridge(page);
  await page.goto('/recording.html?outline');
  await expect(page.locator('.line')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('.bar')).toHaveCount(0);
  expect(await page.locator('.line').evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
});

test('Settings offers Record Video and the recording options on a Mac that can record', async ({ page }) => {
  const saved = { appearance: 'dark', shortcut: 'Super+Digit4', recordMic: false, recordClicks: true };
  await installBridge(page, { returns: { get_settings: saved, login_enabled: false, recording_supported: true,
                                          set_record_options: { ...saved, recordMic: true } } });
  await page.goto('/settings.html');
  await expect(page.locator('.recorder[data-way="record"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.record-clicks')).toBeChecked();
  await expect(page.locator('.record-mic')).not.toBeChecked();
  await page.locator('.record-mic').check();
  expect((await waitFor(page, 'set_record_options')).args).toEqual({ mic: true });
  await expect(page.locator('.record-mic')).toBeChecked();
});

test('…and neither where it cannot', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: { appearance: 'dark', shortcut: 'Super+Digit4' }, login_enabled: false,
                                          recording_supported: false } });
  await page.goto('/settings.html');
  await expect(page.locator('.recorder[data-way="window"]')).toBeVisible({ timeout: 15_000 });
  await waitFor(page, 'recording_supported');
  await expect(page.locator('.recorder[data-way="record"]')).toBeHidden();
  await expect(page.locator('.record-mic')).toBeHidden();
});

test('a recording’s thumbnail shows how long it runs', async ({ page }) => {
  await installBridge(page, { returns: { thumbnail_image: { id: 2, dataUrl: CAPTURE.dataUrl, width: CAPTURE.width, height: CAPTURE.height, duration: 12.4 } } });
  await page.setViewportSize({ width: 252, height: 182 });
  await page.goto('/thumbnail.html');
  await expect(page.locator('.thumb-length')).toHaveText('0:12', { timeout: 15_000 });
  await expect(page.locator('.thumb-image')).toHaveAttribute('alt', 'The recording just made');
});
