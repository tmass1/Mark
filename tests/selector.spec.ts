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

test('guides follow the pointer while aiming, and leave once a region is settled', async ({ page }) => {
  await overlay(page);
  const x = page.locator('.guide-x'), y = page.locator('.guide-y');
  await expect(x).toBeHidden();                      // nothing to aim at yet

  await page.mouse.move(300, 220);
  await expect(x).toBeVisible();
  await expect(y).toBeVisible();
  expect(await x.evaluate(node => node.style.top)).toBe('220px');
  expect(await y.evaluate(node => node.style.left)).toBe('300px');

  await page.mouse.move(480, 360);
  expect(await x.evaluate(node => node.style.top)).toBe('360px');
  expect(await y.evaluate(node => node.style.left)).toBe('480px');

  // They stay up through the drag, which is when lining an edge up matters.
  await page.mouse.move(120, 100);
  await page.mouse.down();
  await page.mouse.move(520, 400, { steps: 6 });
  await expect(x).toBeVisible();
  await page.mouse.up();

  // Settled: the panel takes over and the guides get out of the way.
  await expect(page.locator('.panel')).toBeVisible();
  await expect(x).toBeHidden();
  await expect(y).toBeHidden();
});

test('guides come back when a settled region is adjusted', async ({ page }) => {
  await overlay(page);
  await select(page, [120, 100], [520, 400]);
  await expect(page.locator('.guide-x')).toBeHidden();
  await page.mouse.move(520, 400);
  await page.mouse.down();
  await page.mouse.move(600, 460, { steps: 5 });
  await expect(page.locator('.guide-x')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('.guide-x')).toBeHidden();
});

test('guides do not aim through the panel', async ({ page }) => {
  await overlay(page);
  await select(page, [120, 100], [520, 400]);
  await page.mouse.move(300, 250);                   // over the selection
  await expect(page.locator('.guide-x')).toBeHidden();
  const panel = (await page.locator('.panel').boundingBox())!;
  await page.mouse.move(panel.x + panel.width / 2, panel.y + panel.height / 2);
  await expect(page.locator('.guide-x')).toBeHidden();
});
