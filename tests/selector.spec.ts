import { test, expect } from '@playwright/test';

/** The overlay runs in its own window, so it gets its own page. */
async function overlay(page: import('@playwright/test').Page, delay?: number) {
  if (delay !== undefined) {
    await page.addInitScript(`window.__MARK_DELAY__ = ${delay};`);
  }
  await page.goto('/selector.html');
  await page.waitForSelector('.veil');
}
async function select(page: import('@playwright/test').Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 10 });
  await page.mouse.up();
}

test('dragging out a region shows its size and the panel', async ({ page }) => {
  await overlay(page);
  await expect(page.locator('.panel')).toBeHidden();
  await select(page, [120, 100], [520, 400]);
  await expect(page.locator('.panel')).toBeVisible();
  await expect(page.locator('.w')).toHaveValue('400');
  await expect(page.locator('.h')).toHaveValue('300');
  await expect(page.locator('.grip')).toHaveCount(4);
});

test('the timer cycles through its delays and shows which is armed', async ({ page }) => {
  await overlay(page);
  await select(page, [120, 100], [520, 400]);
  const timer = page.locator('.delay');
  await expect(timer).not.toHaveClass(/armed/);

  for (const seconds of ['3s', '5s', '10s']) {
    await timer.click();
    await expect(timer).toHaveClass(/armed/);
    await expect(timer.locator('.delay-label')).toHaveText(seconds);
  }
  await timer.click();                                   // back round to off
  await expect(timer).not.toHaveClass(/armed/);
  await expect(timer.locator('.delay-label')).toHaveCount(0);
});

test('a delay chosen before the overlay opened is already armed', async ({ page }) => {
  await overlay(page, 5);
  await select(page, [120, 100], [520, 400]);
  await expect(page.locator('.delay')).toHaveClass(/armed/);
  await expect(page.locator('.delay .delay-label')).toHaveText('5s');
  // And still cycles on from there rather than starting over.
  await page.locator('.delay').click();
  await expect(page.locator('.delay .delay-label')).toHaveText('10s');
});

test('an implausible injected delay is ignored', async ({ page }) => {
  await overlay(page, 7);
  await select(page, [120, 100], [520, 400]);
  await expect(page.locator('.delay')).not.toHaveClass(/armed/);
});

test('the ratio lock keeps the shape while a corner is dragged', async ({ page }) => {
  await overlay(page);
  await select(page, [120, 100], [520, 300]);            // 400 x 200, ratio 2
  await page.locator('.lock').click();
  await expect(page.locator('.lock')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(520, 300);
  await page.mouse.down();
  await page.mouse.move(720, 340, { steps: 8 });
  await page.mouse.up();
  const width = Number(await page.locator('.w').inputValue());
  const height = Number(await page.locator('.h').inputValue());
  expect(Math.abs(width / height - 2)).toBeLessThan(0.05);
});

test('the whole-display button takes everything', async ({ page }) => {
  await overlay(page);
  await select(page, [120, 100], [320, 260]);
  await page.locator('.full').click();
  const size = page.viewportSize()!;
  await expect(page.locator('.w')).toHaveValue(String(size.width));
  await expect(page.locator('.h')).toHaveValue(String(size.height));
});
