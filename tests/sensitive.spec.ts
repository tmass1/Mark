import { test, expect, type Page } from '@playwright/test';
import { installBridge, waitFor, clear } from './bridge';
import { CAPTURE } from './fixture';

/** Hide Sensitive, against the real invoke path: Vision's part -- the words
 *  and faces -- is a canned scan in image pixels; finding what is sensitive in
 *  it and covering each find run for real. */

const word = (text: string, x: number, y: number) => ({ text, x, y, width: text.length * 6, height: 12 });
const line = (...words: ReturnType<typeof word>[]) => {
  const left = Math.min(...words.map(w => w.x)), right = Math.max(...words.map(w => w.x + w.width));
  return { text: words.map(w => w.text).join(' '), x: left, y: words[0].y, width: right - left, height: 12, words };
};
/** On the 240 × 160 fixture: an address and a number to hide, words to leave, a face. */
const SCAN = {
  lines: [
    line(word('Mail', 10, 10), word('ana@example.com', 40, 10)),
    line(word('Call', 10, 40), word('+1', 40, 40), word('415', 58, 40), word('555', 82, 40), word('0134', 106, 40)),
    line(word('Order', 10, 70), word('#10482', 46, 70)),
  ],
  faces: [{ x: 170, y: 90, width: 40, height: 48 }],
};

async function open(page: Page, scan: unknown = SCAN) {
  await installBridge(page, { returns: { scan_image: scan } });
  await page.goto('/');
  await page.locator('.capture').waitFor();
  await clear(page);
}

/** A mark's box in image pixels, read back from the overlay it is drawn in. */
function boxes(page: Page) {
  return page.evaluate(([width]) => {
    const svg = document.querySelector('.overlay') as SVGSVGElement;
    const scale = width / svg.getBoundingClientRect().width, origin = svg.getBoundingClientRect();
    return [...document.querySelectorAll('.shape')].map(group => {
      const r = group.getBoundingClientRect();
      return { x: (r.left - origin.left) * scale, y: (r.top - origin.top) * scale, width: r.width * scale, height: r.height * scale };
    });
  }, [CAPTURE.width] as const);
}

test('⇧⌘R covers each sensitive thing with a redaction, in one step that ⌘Z takes back', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Meta+Shift+r');
  // The capture's own pixels, bare base64, as for Copy Text.
  expect((await waitFor(page, 'scan_image')).args).toEqual({ png: CAPTURE.dataUrl.split(',')[1] });
  await expect(page.getByText('Hid an email address, a phone number and a face. ⌘Z puts them back.')).toBeVisible();
  await expect(page.locator('.shape')).toHaveCount(3);
  await expect(page.locator('.chosen')).toHaveText('3 selected');

  // Each covers its find -- the address, the whole number across its four
  // words, the face -- and nothing was laid over "Order #10482".
  const covers = await boxes(page);
  const holds = (outer: { x: number; y: number; width: number; height: number }, x: number, y: number, w: number, h: number) =>
    outer.x <= x + 0.5 && outer.y <= y + 0.5 && outer.x + outer.width >= x + w - 0.5 && outer.y + outer.height >= y + h - 0.5;
  expect(covers.some(c => holds(c, 40, 10, 15 * 6, 12))).toBe(true);
  expect(covers.some(c => holds(c, 40, 40, 106 + 24 - 40, 12))).toBe(true);
  expect(covers.some(c => holds(c, 170, 90, 40, 48))).toBe(true);
  expect(covers.every(c => c.y + c.height < 68 || c.x > 100)).toBe(true);

  await page.keyboard.press('Meta+z');
  await expect(page.locator('.shape')).toHaveCount(0);
});

test('the toolbar offers it with Redact in hand, and only then', async ({ page }) => {
  await open(page);
  const hide = page.getByRole('button', { name: 'Hide Sensitive' });
  await expect(hide).toBeHidden();
  await page.keyboard.press('x');
  await expect(hide).toBeVisible();
  await hide.click();
  await waitFor(page, 'scan_image');
  await expect(page.locator('.shape')).toHaveCount(3);
  await page.keyboard.press('a');
  await expect(hide).toBeHidden();
});

test('a capture with nothing sensitive says so, and is left as it was', async ({ page }) => {
  await open(page, { lines: [line(word('Order', 10, 70), word('#10482', 46, 70))], faces: [] });
  await page.keyboard.press('Meta+Shift+r');
  await expect(page.getByText('Nothing sensitive found: no email addresses, phone or card numbers, keys or faces.')).toBeVisible();
  await expect(page.locator('.shape')).toHaveCount(0);
});

test('the browser preview says Hide Sensitive is the Mac app\'s to do', async ({ page }) => {
  await page.goto('/');
  await page.locator('.capture').waitFor();
  await page.keyboard.press('Meta+Shift+r');
  await expect(page.getByText('Hide Sensitive reads the image on your Mac, so it works in the Mac app.')).toBeVisible();
});
