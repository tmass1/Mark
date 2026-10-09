import { test, expect, type Page } from '@playwright/test';
import { installBridge, emit, sent, clear, waitFor } from './bridge';
import { CAPTURE } from './fixture';

/** The floating thumbnail's page, against the real invoke path. Rust's part --
 *  the panel, the pointer coming and going, how a drag ended -- is played by
 *  the bridge's events, and the five seconds by Playwright's clock. */

const SHOWN = { id: 4, dataUrl: CAPTURE.dataUrl, width: CAPTURE.width, height: CAPTURE.height };

async function open(page: Page) {
  await page.clock.install();
  await installBridge(page, { returns: { thumbnail_image: SHOWN } });
  await page.setViewportSize({ width: 252, height: 182 });
  await page.goto('/thumbnail.html');
  // The first visit can find the dev server still compiling the page.
  await expect(page.locator('.thumb')).toHaveClass(/\bin\b/, { timeout: 15_000 });
  // Settled in its place: the slide in is a CSS transition, which runs on
  // its own time rather than the page's clock.
  await expect.poll(() => page.locator('.thumb').evaluate(element => getComputedStyle(element).transform)).toBe('none');
  await clear(page);
}
const commands = async (page: Page) => (await sent(page)).map(call => call.cmd);

test('it comes in, waits five seconds, then goes, and the capture with it', async ({ page }) => {
  await open(page);
  await page.clock.runFor(4800);
  expect(await commands(page)).not.toContain('close_thumbnail');
  await page.clock.runFor(500);
  expect((await waitFor(page, 'close_thumbnail')).args).toEqual({ id: 4 });
  await expect(page.locator('.thumb')).toHaveClass(/\bout\b/);
});

test('the pointer on it holds it, and the count starts again when it leaves', async ({ page }) => {
  await open(page);
  await page.clock.runFor(3000);
  await emit(page, 'thumbnail-hover', true);
  await expect(page.locator('#thumbnail')).toHaveClass(/hover/);
  await expect(page.locator('.thumb-close')).toBeVisible();
  await page.clock.runFor(20_000);
  expect(await commands(page)).not.toContain('close_thumbnail');
  await emit(page, 'thumbnail-hover', false);
  await page.clock.runFor(4800);
  expect(await commands(page)).not.toContain('close_thumbnail');
  await page.clock.runFor(500);
  await waitFor(page, 'close_thumbnail');
});

test('a click opens the editor on it', async ({ page }) => {
  await open(page);
  await page.locator('.thumb-image').click();
  expect((await waitFor(page, 'open_thumbnail')).args).toEqual({ id: 4 });
  // Taken by the editor, it no longer counts down to going.
  await page.clock.runFor(10_000);
  expect(await commands(page)).not.toContain('close_thumbnail');
});

test('its close button sends it away', async ({ page }) => {
  await open(page);
  await emit(page, 'thumbnail-hover', true);
  await page.locator('.thumb-close').click();
  await page.clock.runFor(300);
  expect((await waitFor(page, 'close_thumbnail')).args).toEqual({ id: 4 });
  expect(await commands(page)).not.toContain('open_thumbnail');
});

test('a swipe to the right sends it away; one that stops short springs back', async ({ page }) => {
  await open(page);
  const swipe = (deltaX: number) => page.locator('#thumbnail').dispatchEvent('wheel', { deltaX, deltaY: 0, bubbles: true, cancelable: true });
  // Fingers moving right scroll left, on a Mac that scrolls naturally.
  await swipe(-20);
  await expect.poll(() => page.locator('.thumb').evaluate(element => element.style.transform)).toBe('translateX(20px)');
  await page.clock.runFor(300);
  await expect.poll(() => page.locator('.thumb').evaluate(element => element.style.transform)).toBe('');
  expect(await commands(page)).not.toContain('close_thumbnail');
  // A swipe left goes nowhere.
  await swipe(40);
  expect(await page.locator('.thumb').evaluate(element => element.style.transform)).toBe('');
  await swipe(-30); await swipe(-30);
  await page.clock.runFor(200);
  await waitFor(page, 'close_thumbnail');
});

test('a drag takes the file, named as Save names it, from where the picture is', async ({ page }) => {
  await open(page);
  const prevented = await page.locator('.thumb-image').evaluate(image =>
    !image.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true })));
  expect(prevented, 'WebKit must not start a drag of its own').toBe(true);
  const call = await waitFor(page, 'drag_thumbnail');
  const box = (await page.locator('.thumb-image').boundingBox())!;
  expect(call.args).toMatchObject({ id: 4, x: box.x, y: box.y, width: box.width, height: box.height });
  expect(String(call.args.name)).toMatch(/^Mark \d{4}-\d\d-\d\d at \d\d\.\d\d\.\d\d\.png$/);
  await expect(page.locator('#thumbnail')).toHaveClass(/dragging/);
  // Held while the drag is under way.
  await page.clock.runFor(10_000);
  expect(await commands(page)).not.toContain('close_thumbnail');
});

test('dropped somewhere it goes at once; let go over nothing it stays, and counts again', async ({ page }) => {
  await open(page);
  await page.locator('.thumb-image').evaluate(image => image.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true })));
  await waitFor(page, 'drag_thumbnail');
  await emit(page, 'thumbnail-dropped', false);
  await expect(page.locator('#thumbnail')).not.toHaveClass(/dragging/);
  await page.clock.runFor(4800);
  expect(await commands(page)).not.toContain('close_thumbnail');
  await page.locator('.thumb-image').evaluate(image => image.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true })));
  await emit(page, 'thumbnail-dropped', true);
  await page.clock.runFor(50);
  expect((await waitFor(page, 'close_thumbnail')).args).toEqual({ id: 4 });
});

test('a new capture replaces it, and an old one\'s number is never sent', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { (window as any).__bridge.returns.thumbnail_image = { ...(window as any).__bridge.returns.thumbnail_image, id: 5 }; });
  await emit(page, 'thumbnail-show', 5);
  await page.locator('.thumb-image').click();
  expect((await waitFor(page, 'open_thumbnail')).args).toEqual({ id: 5 });
});
