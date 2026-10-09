import { test, expect, type Page } from '@playwright/test';
import { installBridge, sent, waitFor, clear } from './bridge';
import { CAPTURE } from './fixture';

/** Copy Text, against the real invoke path: Rust's part -- Vision reading the
 *  image -- is played by canned lines in image pixels, as recognize_text
 *  returns them; the editor's part, choosing and ordering, runs for real. */

const word = (text: string, x: number, y: number, width = text.length * 8) => ({ text, x, y, width, height: 14 });
const line = (...words: ReturnType<typeof word>[]) => {
  const left = Math.min(...words.map(w => w.x)), right = Math.max(...words.map(w => w.x + w.width));
  return { text: words.map(w => w.text).join(' '), x: left, y: words[0].y, width: right - left, height: 14, words };
};
/** Two lines on the 240 × 160 fixture: one across the top, one lower left --
 *  found in the wrong order, as Vision may well give them. */
const LINES = [
  line(word('Gamma', 10, 110), word('delta', 60, 110)),
  line(word('Alpha', 10, 20), word('Beta', 160, 20)),
];

async function open(page: Page, lines: unknown = LINES) {
  await installBridge(page, { returns: { recognize_text: lines } });
  await page.goto('/');
  await page.locator('.capture').waitFor();
  await clear(page);
}

test('⇧⌘T reads the capture as it stands and copies its text in reading order', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Meta+Shift+t');
  const read = await waitFor(page, 'recognize_text');
  // The capture's own pixels, bare base64: not flattened, not framed.
  expect(read.args).toEqual({ png: CAPTURE.dataUrl.split(',')[1] });
  expect((await waitFor(page, 'copy_text')).args).toEqual({ text: 'Alpha Beta\nGamma delta' });
  await expect(page.getByText('Copied 2 lines of text.')).toBeVisible();
});

test('with a box selected, only the words inside it are copied', async ({ page }) => {
  await open(page);
  // A box round the left of the capture: Alpha and Gamma delta, not Beta.
  await page.keyboard.press('b');
  const box = (await page.locator('.overlay').boundingBox())!;
  const at = (x: number, y: number) => ({ x: box.x + (x / CAPTURE.width) * box.width, y: box.y + (y / CAPTURE.height) * box.height });
  const from = at(2, 4), to = at(120, 150);
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 }); await page.mouse.up();
  await expect(page.locator('.shape')).toHaveCount(1);
  await clear(page);
  await page.getByRole('button', { name: 'Copy text' }).click();
  expect((await waitFor(page, 'copy_text')).args).toEqual({ text: 'Alpha\nGamma delta' });
  await expect(page.getByText('Copied 2 lines of text from the box.')).toBeVisible();
});

test('a capture with no words says so, and copies nothing', async ({ page }) => {
  await open(page, []);
  await page.getByRole('button', { name: 'Copy text' }).click();
  await waitFor(page, 'recognize_text');
  await expect(page.getByText('No text in the image.')).toBeVisible();
  expect((await sent(page)).map(call => call.cmd)).not.toContain('copy_text');
});

test('a failure to read is reported, not swallowed', async ({ page }) => {
  await installBridge(page, { fails: { recognize_text: "The text couldn't be read (no image)." } });
  await page.goto('/');
  await page.locator('.capture').waitFor();
  await page.keyboard.press('Meta+Shift+t');
  await expect(page.getByText("The text couldn't be read (no image).")).toBeVisible();
});

test('the browser preview says Copy Text is the Mac app\'s to do', async ({ page }) => {
  await page.goto('/');
  await page.locator('.capture').waitFor();
  await page.keyboard.press('Meta+Shift+t');
  await expect(page.getByText('Copy Text reads the image on your Mac, so it works in the Mac app.')).toBeVisible();
});

// The first reading on a Mac takes seconds while macOS prepares to read text;
// every one after takes half of one. The status stays up until the reading
// is done, and says why, rather than leaving a capture that seems to ignore ⇧⌘T.
test('a slow first reading says it is still reading, and why', async ({ page }) => {
  await installBridge(page, { holds: ['recognize_text'] });
  await page.goto('/');
  await page.locator('.capture').waitFor();
  await page.keyboard.press('Meta+Shift+t');
  await expect(page.getByText('Reading the text…')).toBeVisible();
  await page.waitForTimeout(2000);                                   // past where a passing message would have gone
  await expect(page.getByText('Reading the text…', { exact: false })).toBeVisible();
  await expect(page.getByText('Reading the text… The first time can take a few seconds.')).toBeVisible();
});
