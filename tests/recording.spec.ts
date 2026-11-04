import { test, expect, type Page } from '@playwright/test';
import { installBridge, emit, sent, clear, waitFor } from './bridge';
import { CAPTURE } from './fixture';
import { DEFAULT_FRAME, frameGeometry } from '../src/frame';

/** Screen recordings, against the real invoke path: the overlay picking what
 *  to record, the bar beside one, and the editor playing, trimming and handing
 *  one on. The movie itself is Rust's -- and Playwright's Chromium plays no
 *  H.264 -- so what is checked is what each page asks Rust to do. */

const VIDEO = { ...CAPTURE, scale: 1, video: { id: 7, path: '/Recordings/7/Mark 2026-10-29 at 09.41.07.mp4', duration: 12, sound: false } };

async function editing(page: Page, options: { request?: boolean } = {}) {
  await installBridge(page, {
    capture: VIDEO,
    request: options.request ? { id: 3, client: 'Claude Code', prompt: 'the chart', mode: 'region' } : null,
    returns: { recording_supported: true, video_frames: [CAPTURE.dataUrl, CAPTURE.dataUrl], save_video: { name: 'Mark 2026-10-29 at 09.41.07.mp4', bytes: 3_400_000 }, copy_gif: 820_000 },
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
  // What a recording goes without: cropping, reading its text, zoom. It can be framed.
  await expect(page.locator('.tool[data-slot="9"]')).toBeHidden();
  await expect(page.locator('.trim .frame-toggle')).toBeVisible();
  await expect(page.locator('.copy-text')).toBeHidden();
  await expect(page.locator('.zoom')).toBeHidden();
  // Save says it saves the video; a GIF is the other way, in the menu beside it.
  await expect(page.locator('.save')).toHaveText('Save Video');
  await expect(page.locator('.save-more')).toBeVisible();
  await expect(page.locator('.save-menu')).toBeHidden();
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
  await expect(page.locator('.message')).toContainText('Saved as Mark 2026-10-29 at 09.41.07.mp4 (3.4 MB).');
  await clear(page);
  await page.locator('.save-more').click();
  await expect(page.getByRole('menuitem')).toHaveText([/Save Video\s*⌘S/, /Save as GIF\s*⌥⌘S/, /Copy as GIF/]);
  await page.getByRole('menuitem', { name: /Save as GIF/ }).click();
  expect((await waitFor(page, 'save_video')).args).toMatchObject({ id: 7, gif: true, name: 'Mark 2026-10-29 at 09.41.07.gif' });
  await expect(page.locator('.save-menu')).toBeHidden();
  // Escape closes the menu, not the recording.
  await page.locator('.save-more').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.save-menu')).toBeHidden();
  await expect(page.locator('.movie')).toBeVisible();
  await page.locator('.share').click();
  expect((await waitFor(page, 'share_video')).args).toMatchObject({ id: 7 });

  await clear(page);
  await page.keyboard.press('Alt+Meta+c');
  expect((await waitFor(page, 'copy_video')).args).toMatchObject({ id: 7, close: true });
  expect(await commands(page)).not.toContain('copy_capture');
});

test('a GIF can be copied, full size or small, and says how big it came out', async ({ page }) => {
  await editing(page);
  await page.evaluate(() => { try { localStorage.removeItem('mark.gifSize'); } catch { /* none */ } });
  await page.locator('.save-more').click();
  await expect(page.getByRole('button', { name: 'Full' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Small' }).click();
  await expect(page.locator('.save-menu')).toBeVisible();          // choosing a size keeps the menu open
  await expect(page.getByRole('button', { name: 'Small' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('menuitem', { name: 'Copy as GIF' }).click();
  expect((await waitFor(page, 'copy_gif')).args).toMatchObject({ id: 7, small: true, speed: 1, name: 'Mark 2026-10-29 at 09.41.07.gif' });
  await expect(page.locator('.message')).toContainText('Copied the GIF (820 KB).');
  // Remembered: the next GIF saved is small too.
  await clear(page);
  await page.keyboard.press('Meta+Alt+s');
  expect((await waitFor(page, 'save_video')).args).toMatchObject({ gif: true, small: true });
});

test('2× plays it, and every copy of it, twice as fast, and Recent keeps that', async ({ page }) => {
  await editing(page);
  await page.locator('.speed').click();
  await expect(page.locator('.speed')).toHaveText('2×');
  await expect(page.locator('.trim-time')).toHaveText('0:06 at 2×');
  expect(await page.locator('.movie').evaluate(video => (video as HTMLVideoElement).playbackRate)).toBe(2);
  await clear(page);
  await page.keyboard.press('Meta+c');
  expect((await waitFor(page, 'copy_video')).args).toMatchObject({ speed: 2 });
  await page.keyboard.press('Escape');
  await waitFor(page, 'dismiss_editor');
  await expect(page.locator('.recent').first().locator('.recent-length')).toHaveText('0:06');
  await page.locator('.recent').first().click();
  await expect(page.locator('.speed')).toHaveText('2×');
  await page.locator('.speed').click();
  await expect(page.locator('.trim-time')).toHaveText('0:12');
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

test('a recording’s marks are drawn in the note style, so the movie wears what the editor shows', async ({ page }) => {
  await editing(page);
  await seek(page, 0.25);
  await arrow(page, [0.2, 0.2], [0.6, 0.6]);
  await page.keyboard.press('Escape');
  const overlay = async () => {
    await clear(page);
    await page.keyboard.press('Meta+c');
    const { marks } = (await waitFor(page, 'copy_video')).args as { marks: { overlays: { png: string }[] } };
    return marks.overlays[0].png;
  };
  const smoked = await overlay();
  await page.locator('.note-styles[data-where="bar"] .note-style-button').click();
  await page.getByRole('menuitemradio', { name: 'Icon glass' }).click();
  await page.keyboard.press('Escape');
  expect(await overlay()).not.toBe(smoked);
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

test('a mark can go before the end: its end flag drags, and the copy has it gone from then', async ({ page }) => {
  await editing(page);
  await seek(page, 0.25);                                   // 0:03
  await arrow(page, [0.3, 0.3], [0.7, 0.4]);
  const until = page.locator('.mark-until');
  await expect(until).toBeVisible();
  await expect(until).toHaveAttribute('data-tip', 'Stays to the end: drag to make it go sooner');
  const flag = (await until.boundingBox())!;
  const strip = (await page.locator('.strip').boundingBox())!;
  await page.mouse.move(flag.x + flag.width / 2, flag.y + flag.height - 4);
  await page.mouse.down();
  await page.mouse.move(strip.x + strip.width * 0.5, strip.y + strip.height - 4, { steps: 5 });
  await page.mouse.up();
  await expect(until).toHaveAttribute('data-tip', 'Gone at 0:06: drag to change it');

  await page.keyboard.press('Escape');                      // let it go, then look in its time and after
  await seek(page, 0.4);
  await expect(page.locator('.overlay [data-item]')).toHaveCount(1);
  await seek(page, 0.6);
  await expect(page.locator('.overlay [data-item]')).toHaveCount(0);

  // Copied: a picture of the marks from 0:03, and one from 0:06 without it.
  await clear(page);
  await page.keyboard.press('Meta+c');
  const marks = ((await waitFor(page, 'copy_video')).args as { marks: { overlays: { at: number; png: string }[] } }).marks;
  expect(marks.overlays.map(overlay => Math.round(overlay.at))).toEqual([3, 6]);

  // One undo, and it stays again.
  await page.keyboard.press('Meta+z');
  await seek(page, 0.6);
  await expect(page.locator('.overlay [data-item]')).toHaveCount(1);
});

test('[ and ] start and end the selected mark at the playhead, a redaction too', async ({ page }) => {
  await editing(page);
  await page.keyboard.press('x');                           // Redact
  await seek(page, 0.25);                                   // 0:03
  await arrow(page, [0.1, 0.1], [0.4, 0.4]);
  await seek(page, 0.75);                                   // 0:09
  await page.keyboard.press(']');
  await expect(page.locator('.mark-until')).toHaveAttribute('data-tip', 'Gone at 0:09: drag to change it');
  // Its start can't come after its end.
  await seek(page, 0.9);
  await page.keyboard.press('[');
  await expect(page.locator('.mark-at')).toHaveAttribute('data-tip', 'Appears at 0:03: drag to change it');
  await seek(page, 0.5);                                    // 0:06
  await page.keyboard.press('[');
  await expect(page.locator('.mark-at')).toHaveAttribute('data-tip', 'Appears at 0:06: drag to change it');
  await clear(page);
  await page.locator('.save').click();
  const marks = ((await waitFor(page, 'save_video')).args as { marks: { redactions: { at: number; until?: number }[] } }).marks;
  expect(marks.redactions[0].at).toBeCloseTo(6, 0);
  expect(marks.redactions[0].until).toBeCloseTo(9, 0);
});

test('a redaction on a recording is pixelated by Rust in every frame, and a mark at each moment is its own picture', async ({ page }) => {
  await editing(page);
  await page.keyboard.press('x');                           // Redact
  await seek(page, 0.5);                                    // 0:06
  await arrow(page, [0.1, 0.1], [0.4, 0.4]);
  await expect(page.locator('.redact-live')).toHaveCount(1);
  await page.keyboard.press('a');
  await seek(page, 0.04);                                   // just past the start handle: 0:00
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

test('a part can be cut out of the middle: Cut makes one, its handles move, × puts it back, and copies leave it out', async ({ page }) => {
  await editing(page);
  await seek(page, 0.5);                                    // 0:06
  await page.locator('.cut-out').click();
  await expect(page.locator('.cut')).toHaveCount(1);
  await expect(page.locator('.trim-time')).toHaveText('0:11 of 0:12');
  await clear(page);
  await page.keyboard.press('Meta+c');
  const copied = (await waitFor(page, 'copy_video')).args as { cuts: [number, number][] };
  expect(copied.cuts).toHaveLength(1);
  expect(copied.cuts[0][0]).toBeCloseTo(5.5, 1);
  expect(copied.cuts[0][1]).toBeCloseTo(6.5, 1);

  // Its end handle drags out to 0:09.
  const handle = (await page.locator('.cut .cut-edge[data-cut-edge="end"]').boundingBox())!;
  const strip = (await page.locator('.strip').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(strip.x + strip.width * 0.75, strip.y + strip.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.trim-time')).toHaveText(/^0:0[89] of 0:12$/);

  // K cuts another, at 0:02; the GIF leaves both out.
  await seek(page, 0.17);
  await page.keyboard.press('k');
  await expect(page.locator('.cut')).toHaveCount(2);
  await clear(page);
  await page.keyboard.press('Meta+Alt+s');
  const saved = (await waitFor(page, 'save_video')).args as { gif: boolean; cuts: [number, number][] };
  expect(saved.gif).toBe(true);
  expect(saved.cuts.map(([start, end]) => [Math.round(start), Math.round(end)])).toEqual([[2, 3], [6, 9]]);

  // × puts one back.
  await page.locator('.cut').first().hover();
  await page.locator('.cut').first().locator('.cut-back').click();
  await expect(page.locator('.cut')).toHaveCount(1);
});

test('a recording reopened from Recent keeps its cuts', async ({ page }) => {
  await editing(page);
  await seek(page, 0.5);
  await page.keyboard.press('k');
  await page.keyboard.press('Escape');
  await waitFor(page, 'dismiss_editor');
  const recent = page.locator('.recent').first();
  await expect(recent.locator('.recent-length')).toHaveText('0:11');
  await recent.click();
  await expect(page.locator('.cut')).toHaveCount(1);
  await expect(page.locator('.trim-time')).toHaveText('0:11 of 0:12');
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
async function picking(page: Page, mic: boolean, mode: 'region' | 'window' = 'region', look: object | null = null) {
  await installBridge(page);
  await page.addInitScript(([mic, mode, look]) => {
    const w = window as any;
    w.__MARK_KIND__ = 'video'; w.__MARK_MIC__ = mic; w.__MARK_MODE__ = mode; w.__MARK_DELAY__ = 0; w.__MARK_POINTER__ = null;
    w.__MARK_LOOK__ = look;
    w.__MARK_WINDOWS__ = [{ id: 11, app: 'Safari', title: 'Apple', x: 60, y: 50, width: 400, height: 300 }];
  }, [mic, mode, look] as const);
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

test('a click chooses the window to record, and Record or Return records it with what the bar says', async ({ page }) => {
  await picking(page, false, 'window');
  await expect(page.locator('.hint')).toHaveText('Click a window to choose it · Escape to cancel');
  await expect(page.locator('.choice[aria-checked="true"]')).toHaveText('Window');
  // Nothing to record yet.
  await expect(page.locator('.go')).toBeDisabled();
  // A click, ⌘ or not, only chooses it; it stays chosen as the pointer moves on.
  await page.keyboard.down('Meta');
  await page.mouse.click(200, 150);
  await page.keyboard.up('Meta');
  await expect(page.locator('.pick')).toHaveClass(/held/);
  await expect(page.locator('.pick-name')).toHaveText('Safari — Apple');
  await expect(page.locator('.hint')).toHaveText('Record, or press Return, to record it · Click another window to switch');
  await page.mouse.move(700, 500);
  await expect(page.locator('.pick')).toBeVisible();
  expect(await commands(page)).not.toContain('capture_window');
  // Everything it is recorded with is still in the bar, after choosing.
  await page.locator('.mic').click();
  await page.locator('.delay').click();
  await expect(page.locator('.delay')).toHaveText('3s');
  await page.locator('.go').click();
  expect((await waitFor(page, 'capture_window')).args)
    .toEqual({ id: 11, delay: 3, copy: false, record: true, mic: true, pointer: 'arrow', clicks: 'rings', zoom: false });
});

test('Return records the window chosen, and the bar holds everything a recording is set up with', async ({ page }) => {
  await picking(page, false, 'window');
  const bar = page.locator('.choices');
  for (const name of ['Cancel', 'Region', 'Window', 'Screen', 'Record the microphone too', 'Record after a delay']) {
    await expect(bar.getByRole(name === 'Region' || name === 'Window' || name === 'Screen' ? 'radio' : 'button', { name, exact: true })).toBeVisible();
  }
  await expect(bar.locator('.look-button')).toBeVisible();
  await expect(bar.locator('.go')).toHaveText('Record');
  await page.mouse.click(200, 150);
  await page.keyboard.press('Enter');
  expect((await waitFor(page, 'capture_window')).args).toMatchObject({ id: 11, record: true });
  // × in the bar cancels.
  const fresh = await page.context().newPage();
  await picking(fresh, false, 'window');
  await fresh.locator('.choices').getByRole('button', { name: 'Cancel', exact: true }).click();
  await waitFor(fresh, 'cancel_selection');
});

test('the bar says how the pointer and clicks will show, and its menu changes them before Record', async ({ page }) => {
  await picking(page, false, 'window', { pointer: 'touch', clicks: 'ripple' });
  const button = page.locator('.look-button');
  await expect(button).toHaveText('Touch · Ripple');
  await button.click();
  const menu = page.getByRole('menu', { name: 'Pointer and clicks' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: /Touch/ })).toHaveAttribute('aria-checked', 'true');
  // Nothing is dimmed before recording: every choice can be had.
  await expect(menu.locator('[aria-disabled="true"]')).toHaveCount(0);
  // A choice takes at once, and the menu stays for the other half.
  await menu.getByRole('menuitemradio', { name: /Hidden/ }).click();
  await expect(button).toHaveText('Hidden · Ripple');
  await menu.getByRole('menuitemradio', { name: /Rings/ }).click();
  await expect(button).toHaveText('Hidden · Rings');
  await expect(menu).toBeVisible();
  // Escape puts the menu away, not the overlay; a click away from it only
  // closes it, rather than recording the window under it.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  expect(await commands(page)).not.toContain('cancel_selection');
  await button.click();
  await page.mouse.click(200, 150);
  await expect(menu).toBeHidden();
  await expect(page.locator('.pick')).not.toHaveClass(/held/);
  await page.mouse.click(200, 150);
  await page.keyboard.press('Enter');
  expect((await waitFor(page, 'capture_window')).args)
    .toEqual({ id: 11, delay: 0, copy: false, record: true, mic: false, pointer: 'hidden', clicks: 'rings', zoom: false });
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
  await expect(page.locator('.hint')).toHaveText('Click a window to choose it · Escape to cancel');
  expect(await sent(page)).toEqual([]);                        // pressing a choice records nothing

  // Screen: all of this display, ready to record.
  await choice('Screen').click();
  await expect(choice('Screen')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.go')).toBeVisible();
  // A recording is set up in its bar alone, its size said over it.
  await expect(page.locator('.panel')).toBeHidden();
  await expect(page.locator('.readout')).toBeVisible();
  const bar = (await page.locator('.choices').boundingBox())!;
  expect(bar.y + bar.height).toBeLessThanOrEqual(page.viewportSize()!.height);

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
  const saved = { appearance: 'dark', shortcut: 'Super+Digit4', recordMic: false, recordingPointer: 'arrow', recordingClicks: 'rings' };
  await installBridge(page, { returns: { get_settings: saved, login_enabled: false, recording_supported: true,
                                          set_record_options: { ...saved, recordMic: true } } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Capture' }).click();
  await expect(page.locator('.recorder[data-way="record"]')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('tab', { name: 'Recording' }).click();
  await expect(page.locator('.record-clicks')).toHaveValue('rings');
  await expect(page.locator('.record-mic')).not.toBeChecked();
  await page.locator('.record-mic').check();
  expect((await waitFor(page, 'set_record_options')).args).toEqual({ mic: true });
  await expect(page.locator('.record-mic')).toBeChecked();
});

test('zooming in on clicks is chosen in the bar before recording, off until it is', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await picking(page, false, 'window');
  // With the pointer and clicks, since it is about the clicks: off until chosen.
  const button = page.locator('.look-button');
  await expect(button).toHaveText('Arrow · Rings');
  await button.click();
  const menu = page.getByRole('menu', { name: 'Pointer and clicks' });
  await expect(menu.getByRole('menuitemradio', { name: /^Off/ })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('menuitemradio', { name: /In on clicks/ }).click();
  await expect(button).toHaveText('Arrow · Rings · Zoom');
  await page.keyboard.press('Escape');
  await page.mouse.click(200, 150);
  // Chosen, the bar glides to just under the window, where the eye already is.
  const pick = (await page.locator('.pick').boundingBox())!;
  await expect.poll(async () => {
    const bar = (await page.locator('.choices').boundingBox())!;
    return [bar.y > pick.y + pick.height && bar.y < pick.y + pick.height + 40, bar.x < pick.x + pick.width && bar.x + bar.width > pick.x];
  }).toEqual([true, true]);
  await page.keyboard.press('Enter');
  expect((await waitFor(page, 'capture_window')).args).toMatchObject({ id: 11, zoom: true });
});

test('Settings turns zooming in on clicks on for the next recording', async ({ page }) => {
  const saved = { appearance: 'dark', shortcut: 'Super+Digit4' };
  await installBridge(page, { returns: { get_settings: saved, login_enabled: false, recording_supported: true,
                                          set_record_options: { ...saved, recordZoom: true } } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Recording' }).click({ timeout: 15_000 });
  const zoom = page.getByRole('checkbox', { name: 'Zoom in on clicks' });
  await expect(zoom).not.toBeChecked({ timeout: 15_000 });
  await zoom.check();
  expect((await waitFor(page, 'set_record_options')).args).toEqual({ zoom: true });
  await expect(zoom).toBeChecked();
});

test('Settings chooses how a recording shows the pointer and clicks', async ({ page }) => {
  const saved = { appearance: 'dark', shortcut: 'Super+Digit4', recordingPointer: 'arrow', recordingClicks: 'none' };
  await installBridge(page, { returns: { get_settings: saved, login_enabled: false, recording_supported: true,
                                          set_record_options: { ...saved, recordingPointer: 'touch' } } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Recording' }).click({ timeout: 15_000 });
  const pointer = page.getByRole('combobox', { name: 'Pointer' });
  const clicks = page.getByRole('combobox', { name: 'Clicks' });
  await expect(pointer).toHaveValue('arrow', { timeout: 15_000 });
  await expect(clicks).toHaveValue('none');
  await pointer.selectOption('touch');
  expect((await waitFor(page, 'set_record_options')).args).toEqual({ pointer: 'touch' });
  await expect(pointer).toHaveValue('touch');
  await clear(page);
  await clicks.selectOption('ripple');
  expect((await waitFor(page, 'set_record_options')).args).toEqual({ clicks: 'ripple' });
});

/** A recording whose pointer Mark followed through the middle of the picture,
 *  made as `look` says, with the button down from 0:06 to 0:07. */
async function followed(page: Page, look: object, track = Array.from({ length: 121 }, (_, i) => [i / 10, 120, 80]), zoom = true) {
  await installBridge(page, { capture: VIDEO, returns: { recording_supported: true, video_frames: [CAPTURE.dataUrl],
                                                          video_pointer: { track, presses: [[6, 7]], look, zoom } } });
  await page.goto('/');
  await expect(page.locator('.trim')).toBeVisible({ timeout: 15_000 });
}
/** Whether an element sits on the middle of the picture. */
async function centred(page: Page, selector: string) {
  const [box, stage] = [(await page.locator(selector).first().boundingBox())!, (await page.locator('.stage').boundingBox())!];
  expect(box.x + box.width / 2).toBeCloseTo(stage.x + stage.width / 2, 0);
  expect(box.y + box.height / 2).toBeCloseTo(stage.y + stage.height / 2, 0);
}

test('a recording with the Mac’s arrow can take a halo, but not what it was recorded without', async ({ page }) => {
  await followed(page, { pointer: 'arrow', clicks: 'rings' });
  const button = page.getByRole('button', { name: 'Pointer and clicks' });
  await expect(button).toBeVisible();
  await expect(page.locator('.pointer-halo')).toBeHidden();
  await button.click();
  const menu = page.getByRole('menu', { name: 'Pointer and clicks' });
  const dimmed = menu.locator('[aria-disabled="true"]');
  await expect(dimmed).toHaveCount(4);
  await expect(menu.getByRole('menuitemradio', { name: /Touch/ })).toContainText('The arrow is in this one');
  await expect(menu.getByRole('menuitemradio', { name: /Ripple/ })).toContainText('Rings are in this one');
  // A dimmed one does nothing.
  await menu.getByRole('menuitemradio', { name: /Touch/ }).click({ force: true });
  await expect(menu.getByRole('menuitemradio', { name: /Arrow/ })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('menuitemradio', { name: /Halo/ }).click();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await seek(page, 0.25);
  await expect(page.locator('.pointer-halo')).toBeVisible();
  await centred(page, '.pointer-halo');
  await expect(page.locator('.pointer-touch')).toBeHidden();
  await clear(page);
  await page.keyboard.press('Meta+c');
  expect((await waitFor(page, 'copy_video')).args).toMatchObject({ look: { pointer: 'halo', clicks: 'rings' } });
});

test('a recording made with Touch shows a fingertip, pressed while the button was down, and a ripple where it went down', async ({ page }) => {
  await followed(page, { pointer: 'touch', clicks: 'ripple' });
  const touch = page.locator('.pointer-touch');
  await seek(page, 0.25);                                   // 0:03
  await expect(touch).toBeVisible();
  await centred(page, '.pointer-touch');
  await expect(touch).not.toHaveClass(/pressed/);
  await expect(page.locator('.pointer-ripple:visible')).toHaveCount(0);
  await seek(page, 0.51);                                   // 0:06.1, just pressed
  await expect(touch).toHaveClass(/pressed/);
  await expect(page.locator('.pointer-ripple:visible')).toHaveCount(1);
  await centred(page, '.pointer-ripple');
  await seek(page, 0.75);                                   // 0:09, let go long since
  await expect(touch).not.toHaveClass(/pressed/);
  await expect(page.locator('.pointer-ripple:visible')).toHaveCount(0);
  // Recorded without the arrow and the rings: those are dimmed, the rest can change.
  await page.getByRole('button', { name: 'Pointer and clicks' }).click();
  const menu = page.getByRole('menu', { name: 'Pointer and clicks' });
  await expect(menu.getByRole('menuitemradio', { name: /Arrow/ })).toContainText('Recorded without it');
  await expect(menu.getByRole('menuitemradio', { name: /Rings/ })).toContainText('Only while recording');
  await menu.getByRole('menuitemradio', { name: /Hidden/ }).click();
  await menu.getByRole('menuitemradio', { name: /None/ }).click();
  await expect(touch).toBeHidden();
  await clear(page);
  await page.keyboard.press('Meta+c');
  expect((await waitFor(page, 'copy_video')).args).toMatchObject({ look: { pointer: 'hidden', clicks: 'none' } });
  // Recent keeps it.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await waitFor(page, 'dismiss_editor');
  await page.locator('.recent').first().click();
  await page.getByRole('button', { name: 'Pointer and clicks' }).click();
  await expect(menu.getByRole('menuitemradio', { name: /Hidden/ })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitemradio', { name: /None/ })).toHaveAttribute('aria-checked', 'true');
});

test('a recording can be framed too, in a phone, and every copy is sent the frame to set it in', async ({ page }) => {
  await editing(page);
  // Its style opens over the video, from Frame under it, and frames it.
  const panel = page.locator('.frame-panel');
  await expect(panel).toBeHidden();
  await page.locator('.trim .frame-toggle').click();
  await expect(panel).toBeVisible();
  await expect(page.locator('.canvas')).toHaveClass(/framed/);
  // A movie can't be see-through.
  await expect(panel.getByRole('radio', { name: 'No background', exact: true })).toBeDisabled();
  await panel.getByRole('radio', { name: 'Lagoon', exact: true }).click();
  await panel.locator('.devices').getByRole('radio', { name: 'Phone', exact: true }).click();
  await expect(page.locator('.canvas')).toHaveClass(/framed/);
  const geometry = frameGeometry(VIDEO.width, VIDEO.height, 1, { ...DEFAULT_FRAME, on: true, background: 'lagoon', device: 'phone' });
  await expect(page.locator('.dimensions')).toHaveText(`${geometry.width} × ${geometry.height} px, framed · 0:12`);
  await clear(page);
  await page.keyboard.press('Meta+c');
  const { frame } = (await waitFor(page, 'copy_video')).args.marks as { frame: Record<string, number | string> };
  expect(frame).toMatchObject({ width: geometry.width, height: geometry.height,
                                x: geometry.pad + geometry.bezel, y: geometry.pad + geometry.bezel });
  // Both pictures are the canvas's size: what lies under, and where the movie shows.
  const sizes = await page.evaluate(async plates => Promise.all(plates.map(async png => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    return [image.width, image.height];
  })), [frame.under as string, frame.mask as string]);
  expect(sizes).toEqual([[geometry.width, geometry.height], [geometry.width, geometry.height]]);
});

test('a zoom is suggested round the clicks, shown on the strip, and its level changed or taken away', async ({ page }) => {
  await followed(page, { pointer: 'touch', clicks: 'ripple' });
  // Pressed from 0:06 to 0:07: in from 0:05, out by 0:09, a gentle 1.5×.
  const band = page.locator('.zoom-band');
  await expect(band).toHaveCount(1);
  await expect(band).toHaveText('1.5×');
  const [box, strip] = [(await band.boundingBox())!, (await page.locator('.strip').boundingBox())!];
  expect((box.x - strip.x) / strip.width).toBeCloseTo(5 / 12, 2);
  expect(box.width / strip.width).toBeCloseTo(4 / 12, 2);
  await band.click();
  const menu = page.getByRole('menu', { name: 'Zoom' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: '1.5×' })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('menuitemradio', { name: '3×' }).click();
  await expect(band).toHaveText('3×');
  await expect(menu).toBeHidden();
  // Every copy is sent where the camera is through it, from the whole picture in.
  await clear(page);
  await page.keyboard.press('Meta+c');
  const { camera } = (await waitFor(page, 'copy_video')).args.marks as { camera: number[][] };
  expect(camera[0]).toEqual([5, 120, 80, 1]);
  expect(Math.max(...camera.map(sample => sample[3]))).toBe(3);
  await band.click();
  await menu.getByRole('menuitem', { name: 'Remove' }).click();
  await expect(band).toHaveCount(0);
  // Taken away, it stays away: Recent keeps none, rather than suggesting it again.
  await page.keyboard.press('Escape');
  await waitFor(page, 'dismiss_editor');
  await page.locator('.recent').first().click();
  await expect(page.locator('.trim')).toBeVisible();
  await waitFor(page, 'video_pointer');
  await expect(page.locator('.zoom-band')).toHaveCount(0);
});

test('Z zooms in at the playhead, and paused, an outline shows what the camera takes', async ({ page }) => {
  await followed(page, { pointer: 'arrow', clicks: 'rings' });
  await expect(page.locator('.zoom-band')).toHaveCount(1);
  await seek(page, 0.25);                                   // 0:03
  await page.keyboard.press('z');
  await expect(page.locator('.zoom-band')).toHaveCount(2);
  await expect(page.locator('.camera-view')).toBeVisible();
  // At 1.5×, with the pointer in the middle of the picture, two thirds of it, centred.
  const [view, stage] = [(await page.locator('.camera-view').boundingBox())!, (await page.locator('.stage').boundingBox())!];
  expect(view.width).toBeCloseTo(stage.width / 1.5, -1);
  expect(view.x + view.width / 2).toBeCloseTo(stage.x + stage.width / 2, -1);
  expect(view.y + view.height / 2).toBeCloseTo(stage.y + stage.height / 2, -1);
  // Nowhere to put one inside another.
  await page.keyboard.press('z');
  await expect(page.locator('.zoom-band')).toHaveCount(2);
  await seek(page, 0.05);                                   // outside them all
  await expect(page.locator('.camera-view')).toBeHidden();
});

test('a recording made without zooming in on clicks opens with no zooms, though one can be added', async ({ page }) => {
  await followed(page, { pointer: 'touch', clicks: 'ripple' }, undefined, false);
  await waitFor(page, 'video_pointer');
  await expect(page.locator('.zoom-band')).toHaveCount(0);
  await seek(page, 0.25);
  await page.keyboard.press('z');
  await expect(page.locator('.zoom-band')).toHaveCount(1);
});

test('the style panel opens over the video against Frame, leaves the video its width, and stays in view when the window is resized', async ({ page }) => {
  await editing(page);
  const panel = page.locator('.frame-panel');
  const toggle = page.locator('.trim .frame-toggle');
  const wide = (await page.locator('.canvas').boundingBox())!.width;
  await toggle.click();
  await expect(panel).toBeVisible();
  const above = async () => {
    const [box, button] = [(await panel.boundingBox())!, (await toggle.boundingBox())!];
    expect(box.y + box.height).toBeLessThanOrEqual(button.y);
    expect(Math.abs(box.x + box.width - (button.x + button.width))).toBeLessThanOrEqual(1);
    expect(box.y).toBeGreaterThanOrEqual(0);
  };
  await above();
  expect((await page.locator('.canvas').boundingBox())!.width).toBe(wide);
  // Mark sizes its window to each recording; the panel follows Frame, and in
  // a short window scrolls rather than leaving it.
  await page.setViewportSize({ width: 1000, height: 420 });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await above();
  expect(await panel.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await panel.getByRole('radio', { name: 'Phone', exact: true }).scrollIntoViewIfNeeded();
  await expect(panel.getByRole('radio', { name: 'Phone', exact: true })).toBeInViewport();
});

test('no pointer menu for a recording whose pointer wasn\'t followed', async ({ page }) => {
  await followed(page, { pointer: 'touch', clicks: 'ripple' }, []);
  await waitFor(page, 'video_pointer');
  await expect(page.getByRole('button', { name: 'Pointer and clicks' })).toBeHidden();
  await expect(page.locator('.pointer-touch')).toBeHidden();
});

test('…and neither where it cannot', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: { appearance: 'dark', shortcut: 'Super+Digit4' }, login_enabled: false,
                                          recording_supported: false } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Capture' }).click();
  await expect(page.locator('.recorder[data-way="window"]')).toBeVisible({ timeout: 15_000 });
  await waitFor(page, 'recording_supported');
  await expect(page.getByRole('tab', { name: 'Recording' })).toBeHidden();
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

test('a delayed shot counts down over what it will take, by the clock, and is gone at the end', async ({ page }) => {
  await installBridge(page);
  const until = await page.evaluate(() => Date.now()) + 2500;
  await page.goto(`/recording.html?countdown&until=${until}&video`);
  const count = page.getByRole('timer');
  await expect(count.locator('.number')).toHaveText('3');
  await expect(count.locator('.what')).toHaveText('Recording');
  await expect(count.locator('.number')).toHaveText('2', { timeout: 2000 });
  await expect(count).toHaveClass(/done/, { timeout: 4000 });
  // Its window has room for its whole shadow, most of all below.
  await page.setViewportSize({ width: 260, height: 260 });
  const disc = (await count.boundingBox())!;
  expect(disc.x).toBeGreaterThanOrEqual(46);
  expect(260 - (disc.y + disc.height)).toBeGreaterThanOrEqual(46);
  // A screenshot's count says so.
  await page.goto(`/recording.html?countdown&until=${Date.now() + 5000}`);
  await expect(page.getByRole('timer').locator('.what')).toHaveText('Screenshot');
});

test('the bar beside a recording can be dragged by all but its buttons, and has room for its shadow', async ({ page }) => {
  await installBridge(page);
  await page.setViewportSize({ width: 256, height: 88 });
  await page.goto('/recording.html');
  for (const part of ['.bar', '.time', '.live', '.gap']) await expect(page.locator(part)).toHaveAttribute('data-tauri-drag-region', '');
  for (const button of ['.stop', '.discard']) await expect(page.locator(button)).not.toHaveAttribute('data-tauri-drag-region');
  // The bar stops short of the window's edges, below most of all, where its shadow falls.
  const bar = (await page.locator('.bar').boundingBox())!;
  expect(bar.y).toBeGreaterThanOrEqual(12);
  expect(88 - (bar.y + bar.height)).toBeGreaterThanOrEqual(30);
  expect(bar.x).toBeGreaterThanOrEqual(20);
});

test('the web view’s own menu never shows over a capture or Recent, only where text is typed', async ({ page }) => {
  await editing(page);
  const prevented = (selector: string) => page.locator(selector).first().evaluate(element => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(await prevented('.capture')).toBe(true);
  expect(await prevented('.stage')).toBe(true);
});

test('Frame under the video opens its panel, which goes with Escape or a click elsewhere, the frame staying', async ({ page }) => {
  await editing(page);
  const panel = page.locator('.frame-panel');
  const toggle = page.locator('.trim .frame-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await panel.getByRole('radio', { name: 'Phone', exact: true }).click();
  await expect(page.locator('.canvas')).toHaveClass(/framed/);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  // Lit while there is a frame, as Frame in a screenshot's footer is.
  await expect(toggle).toHaveClass(/\bon\b/);
  await expect(page.locator('.canvas')).toHaveClass(/framed/);
  await toggle.click();
  await page.locator('.dimensions').click();
  await expect(panel).toBeHidden();
  // Off from its switch, and the next recording opens unframed too.
  await toggle.click();
  await clear(page);
  await page.getByRole('switch', { name: 'Frame the image' }).click();
  await expect(page.locator('.canvas')).not.toHaveClass(/framed/);
  expect((await waitFor(page, 'set_frame')).args).toMatchObject({ frame: { on: false } });
});

test('a recording opens framed as the last one was', async ({ page }) => {
  await installBridge(page, { capture: VIDEO, returns: { recording_supported: true, video_frames: [CAPTURE.dataUrl],
                                                         get_settings: { frame: { ...DEFAULT_FRAME, on: true, device: 'browser' } } } });
  await page.goto('/');
  await expect(page.locator('.canvas')).toHaveClass(/framed/, { timeout: 15_000 });
  await expect(page.locator('.trim .frame-toggle')).toHaveClass(/\bon\b/);
});

test('a tall recording opens in a phone, and a device chosen for it is its own', async ({ page }) => {
  const TALL = { ...VIDEO, width: 160, height: 240 };
  await installBridge(page, { capture: TALL, returns: { recording_supported: true, video_frames: [CAPTURE.dataUrl],
                                                        get_settings: { frame: { ...DEFAULT_FRAME, on: true, device: 'browser' } } } });
  await page.goto('/');
  await expect(page.locator('.canvas')).toHaveClass(/framed/, { timeout: 15_000 });
  const phone = frameGeometry(160, 240, 1, { ...DEFAULT_FRAME, on: true, background: 'sky', device: 'phone' });
  await expect(page.locator('.dimensions')).toHaveText(`${phone.width} × ${phone.height} px, framed · 0:12`);
  await page.locator('.trim .frame-toggle').click();
  const panel = page.locator('.frame-panel');
  await expect(panel.getByRole('radio', { name: 'Phone', exact: true })).toHaveAttribute('aria-checked', 'true');
  await clear(page);
  await panel.getByRole('radio', { name: 'Tablet', exact: true }).click();
  // A desktop recording keeps its browser.
  expect((await waitFor(page, 'set_frame')).args).toMatchObject({ frame: { device: 'browser', tallDevice: 'tablet' } });
});

test('a recording back from Recent grows the window for it, framed as it was left', async ({ page }) => {
  await editing(page);
  await page.locator('.trim .frame-toggle').click();
  await expect(page.locator('.canvas')).toHaveClass(/framed/);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await waitFor(page, 'dismiss_editor');
  await clear(page);
  await page.locator('.recent').first().click();
  expect((await waitFor(page, 'fit_to_recording')).args).toEqual({ width: VIDEO.width, height: VIDEO.height });
  await expect(page.locator('.canvas')).toHaveClass(/framed/);
});

test('Play sits against the timeline, the time just after it, then the tools', async ({ page }) => {
  await editing(page);
  const x = async (selector: string) => (await page.locator(selector).boundingBox())!.x;
  const order = await Promise.all(['.play', '.strip', '.times', '.cut-out', '.zoom-in', '.speed'].map(x));
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  const [play, strip] = [(await page.locator('.play').boundingBox())!, (await page.locator('.strip').boundingBox())!];
  expect(strip.x - (play.x + play.width)).toBeLessThanOrEqual(14);
  // Named in a window wide enough; icons alone in a narrow one, where the timeline needs the room.
  await expect(page.locator('.cut-out span')).toBeHidden();
  await page.setViewportSize({ width: 1200, height: 700 });
  await expect(page.locator('.cut-out')).toContainText('Cut');
  await expect(page.locator('.zoom-in')).toContainText('Zoom');
  await expect(page.locator('.trim .frame-toggle')).toContainText('Frame');
  await seek(page, 0.25);
  await expect(page.locator('.now-time')).toHaveText('0:03 /');
});
