import { test, expect, type Page } from '@playwright/test';
import { installBridge, emit, sent, clear, setBridge, waitFor } from './bridge';
import { CAPTURE } from './fixture';
import { imageTokens, sendSize, MAX_EDGE, MAX_TOKENS } from '../src/send';

/** An AI tool's ask, as the editor shows it and answers it, against the real
 *  invoke path: Rust's part -- the socket, the tool -- is played by the
 *  snapshot's request and by what reaches send_capture and decline_request. */

const ASK = { id: 3, client: 'Claude Code', prompt: 'the error dialog in Xcode', mode: 'region' };

/** A PNG's size, read from its header. */
function pngSize(base64: string): { width: number; height: number } {
  const bytes = Buffer.from(base64, 'base64');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function open(page: Page, options: Parameters<typeof installBridge>[1] = {}) {
  await installBridge(page, { request: ASK, ...options });
  await page.goto('/');
  await page.locator('.request-bar').waitFor();
}

test('an ask waits in a bar over the empty state, with the way it names offered first', async ({ page }) => {
  await open(page, { capture: null, request: { ...ASK, prompt: 'the <b>error</b> “dialog”', mode: 'window' } });
  const bar = page.getByRole('complementary', { name: 'Request for a screenshot' });
  // What the tool sent is text, whatever is in it.
  await expect(bar).toContainText('Claude Code asks to see “the <b>error</b> “dialog””');
  await expect(bar.locator('b')).toHaveCount(0);
  await expect(page.getByText('Bring it on screen, then capture it.')).toBeVisible();
  const tiles = page.getByRole('group', { name: 'Capture' });
  await expect(tiles.locator('[data-start="window"]')).toHaveClass(/primary/);
  await expect(tiles.locator('[data-start="region"]')).not.toHaveClass(/primary/);
  // The bar sits clear of the empty state's pane.
  const barBox = (await bar.boundingBox())!, pane = (await page.locator('.empty').boundingBox())!;
  expect(pane.y).toBeGreaterThanOrEqual(barBox.y + barBox.height);
  await clear(page);
  await bar.getByRole('button', { name: 'Don’t Send' }).click();
  expect((await waitFor(page, 'decline_request')).args).toEqual({ id: 3 });
  await expect(page.getByText('Nothing was sent to Claude Code.')).toBeVisible();
});

test('over a capture the bar keeps clear of the rail, and the capture clear of the bar', async ({ page }) => {
  await open(page);
  const bar = (await page.locator('.request-bar').boundingBox())!;
  const rail = (await page.locator('.rail').boundingBox())!;
  const stage = (await page.locator('.stage').boundingBox())!;
  expect(bar.x).toBeGreaterThanOrEqual(rail.x + rail.width);
  expect(stage.y).toBeGreaterThanOrEqual(bar.y + bar.height);
  await expect(page.locator('footer .copy')).toHaveAccessibleName(/^Send to Claude Code/);
});

/** Two lines as Vision would find them in the fixture, out of order. */
const WORDS = [
  { text: 'Total 42', x: 10, y: 110, width: 80, height: 14, words: [] },
  { text: 'Revenue', x: 10, y: 20, width: 70, height: 14, words: [] },
];

test('Send sends the capture with its marks, without its frame, and says what it is', async ({ page }) => {
  // Framed in Settings: Send leaves the frame out all the same, title bar and all.
  const framed = { on: true, background: 'sky', padding: 0.5, radius: 0.4, shadow: 0.5, chrome: true };
  await open(page, { returns: { get_settings: { appearance: 'dark', shortcut: 'Super+Digit4', frame: framed }, recognize_text: WORDS } });
  await expect(page.locator('.canvas')).toHaveClass(/framed/);
  // A numbered step: a mark, and a step to list. A steps through the arrow's
  // slot, so press it until the numbered arrow is the one in hand.
  const numbered = page.getByRole('radio', { name: 'Numbered arrow', exact: true });
  for (let i = 0; i < 2 && await numbered.count() === 0; i++) await page.keyboard.press('a');
  await expect(numbered).toBeChecked();
  const box = (await page.locator('.overlay').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await page.keyboard.type('open the menu');
  await clear(page);
  await page.getByRole('button', { name: /^Send to Claude Code/ }).click();
  const call = await waitFor(page, 'send_capture');
  expect(call.args.id).toBe(3);
  expect(pngSize(String(call.args.png))).toEqual({ width: CAPTURE.width, height: CAPTURE.height });
  // The words were read off the very picture sent -- marks, redactions and all.
  expect((await sent(page)).find(c => c.cmd === 'recognize_text')?.args).toEqual({ png: call.args.png });
  const text = String(call.args.text);
  expect(text).toContain(`${CAPTURE.width} × ${CAPTURE.height} pixels`);
  expect(text).toMatch(/numbered marks are steps they mean in order:\n1\. a badge at \(\d+, \d+\): “open the menu”/);
  expect(text).toContain('read on their Mac, in reading order (anything redacted is not included):\nRevenue\nTotal 42');
  // Nothing went the copy way.
  expect((await sent(page)).map(c => c.cmd)).not.toContain('copy_edited');
});

test('a Mac that can’t read the words still sends the picture', async ({ page }) => {
  await open(page, { fails: { recognize_text: 'No text recognition here.' } });
  await page.getByRole('button', { name: /^Send to Claude Code/ }).click();
  const text = String((await waitFor(page, 'send_capture')).args.text);
  expect(text).not.toContain('The text in it');
  await expect(page.getByText('No text recognition here.')).toBeHidden();
});

test('a tool that gives up is counted down in the bar; Claude Code, which waits, is not', async ({ page }) => {
  await open(page, { request: { ...ASK, deadline: Date.now() + 42_500 } });
  const wait = page.locator('.request-wait');
  await expect(wait).toHaveText(/^0:4[0-3] left$/);
  await expect(wait).not.toHaveClass(/soon/);
  // Running out, it says so.
  await setBridge(page, { request: { ...ASK, deadline: Date.now() + 9_000 } });
  await emit(page, 'capture-changed');
  await expect(wait).toHaveText(/^0:0\d left$/);
  await expect(wait).toHaveClass(/soon/);
  // Past it, the count goes, and the ask stays until the tool says otherwise.
  await setBridge(page, { request: { ...ASK, deadline: Date.now() - 1_000 } });
  await emit(page, 'capture-changed');
  await expect(wait).toBeHidden();
  await expect(page.locator('.request-bar')).toBeVisible();
  // No deadline, no count.
  await setBridge(page, { request: { ...ASK, deadline: null } });
  await emit(page, 'capture-changed');
  await expect(wait).toBeHidden();
});

test('a large capture is sent at the size Claude looks at', async ({ page }) => {
  await page.goto('about:blank');
  const big = await page.evaluate(() => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 3200, height: 2000 });
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#3a7'; context.fillRect(0, 0, 3200, 2000);
    context.fillStyle = '#fff'; context.fillRect(100, 100, 600, 80);
    return canvas.toDataURL('image/png');
  });
  await open(page, { capture: { dataUrl: big, width: 3200, height: 2000, scale: 2 } as typeof CAPTURE });
  await clear(page);
  await page.getByRole('button', { name: /^Send to Claude Code/ }).click();
  const call = await waitFor(page, 'send_capture');
  const size = pngSize(String(call.args.png));
  expect(size).toEqual(sendSize(3200, 2000));
  expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(MAX_EDGE);
  expect(imageTokens(size.width, size.height)).toBeLessThanOrEqual(MAX_TOKENS);
  expect(String(call.args.text)).toContain(`3200 × 2000 pixels (1600 × 1000 points on a 2× display), sent at ${size.width} × ${size.height}.`);
});

test('⌥⌘C and the menu’s Copy and Close send while an ask waits, and copy otherwise', async ({ page }) => {
  await open(page);
  await clear(page);
  await page.keyboard.press('Meta+Alt+c');
  await waitFor(page, 'send_capture');
  // The menu's item reaches the page as an event -- which is how ⌥⌘C arrives
  // while a note is being typed -- and it sends too. (Rust would have put the
  // editor away; the capture and the ask come back for another go.)
  await emit(page, 'capture-changed');
  await page.locator('.request-bar').waitFor();
  await clear(page);
  await emit(page, 'copy-and-close');
  await waitFor(page, 'send_capture');
  // With no ask, the same key copies and closes, as ever.
  await setBridge(page, { request: null });
  await emit(page, 'capture-changed');
  await expect(page.locator('.request-bar')).toBeHidden();
  await expect(page.locator('footer .copy')).toHaveAccessibleName(/^Copy and Close/);
  await clear(page);
  await page.keyboard.press('Meta+Alt+c');
  await waitFor(page, 'copy_capture');
  expect((await sent(page)).map(c => c.cmd)).not.toContain('send_capture');
});

test('Escape and ⌘W close the editor, which is how Rust hears the ask declined', async ({ page }) => {
  await open(page);
  await clear(page);
  await page.keyboard.press('Escape');
  await waitFor(page, 'dismiss_editor');
  await emit(page, 'capture-changed');
  await page.locator('.request-bar').waitFor();
  await clear(page);
  await page.keyboard.press('Meta+w');
  await waitFor(page, 'dismiss_editor');
  expect((await sent(page)).map(c => c.cmd)).not.toContain('send_capture');
});

test('a tool that stops waiting takes its bar with it, and the editor says why', async ({ page }) => {
  await open(page);
  await setBridge(page, { request: null });
  // Rust's order: the snapshot changes, then it says who stopped waiting.
  await emit(page, 'capture-changed');
  await emit(page, 'request-withdrawn', 'Claude Code');
  await expect(page.locator('.request-bar')).toBeHidden();
  await expect(page.getByText('Claude Code stopped waiting, so nothing was sent.')).toBeVisible();
  await expect(page.locator('footer .copy')).toHaveAccessibleName(/^Copy and Close/);
  // The capture is still there to copy.
  await expect(page.locator('.stage')).toBeVisible();
});

test('a Send that arrives after the ask ended says so, and keeps the capture', async ({ page }) => {
  await open(page, { fails: { send_capture: 'That request has ended, so nothing was sent.' } });
  await page.getByRole('button', { name: /^Send to Claude Code/ }).click();
  await expect(page.getByText('That request has ended, so nothing was sent.')).toBeVisible();
  await expect(page.locator('.stage')).toBeVisible();
});

test('a long ask is cut short in the bar, and the whole of it is in the tip', async ({ page }) => {
  const prompt = 'the dialog that opens after Export, with the checkbox about colour profiles and the two buttons under it';
  await page.setViewportSize({ width: 560, height: 580 });
  await open(page, { request: { ...ASK, prompt } });
  const text = page.locator('.request-text');
  expect(await text.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect(text).toHaveAttribute('data-tip', `Claude Code asks to see “${prompt}”`);
  // Don't Send stays whole, and the bar stays inside the window.
  const decline = (await page.getByRole('button', { name: 'Don’t Send' }).boundingBox())!;
  expect(decline.x + decline.width).toBeLessThanOrEqual(560);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
