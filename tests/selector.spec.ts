import { test, expect, type Page } from '@playwright/test';
import { installBridge, sent, waitFor, emit, emitted, clear } from './bridge';

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

// ---- window mode -------------------------------------------------------------

/** Two windows as the window server lists them, front to back, in global
 *  points: Safari in front, Notes behind it and overlapping it. */
const WINDOWS = [
  { id: 11, app: 'Safari', title: 'Apple', x: 60, y: 50, width: 400, height: 300 },
  { id: 12, app: 'Notes', title: '', x: 340, y: 220, width: 380, height: 300 },
];

/** The overlay as Rust opens it: with the windows on screen, the mode to begin
 *  in and where the pointer was -- and the bridge, to see what it asks for. */
async function picking(page: Page, options: {
  mode?: 'region' | 'window'; pointer?: { x: number; y: number }; delay?: number;
  display?: { x: number; y: number; width: number; height: number; scale: number };
  windows?: typeof WINDOWS; fails?: Record<string, string>;
} = {}) {
  await installBridge(page, { fails: options.fails });
  await page.addInitScript(([o]) => {
    const w = window as any;
    if (o.display) w.__MARK_DISPLAY__ = o.display;
    w.__MARK_WINDOWS__ = o.windows; w.__MARK_MODE__ = o.mode; w.__MARK_POINTER__ = o.pointer; w.__MARK_DELAY__ = o.delay;
  }, [{ display: options.display ?? null, windows: options.windows ?? WINDOWS, mode: options.mode ?? 'region',
        pointer: options.pointer ?? null, delay: options.delay ?? 0 }] as const);
  await page.goto('/selector.html');
  await page.waitForSelector('.hint');
}

test('Space picks windows instead: the one under the pointer is framed and named, and a click takes it', async ({ page }) => {
  await picking(page);
  const hint = page.locator('.hint');
  await expect(hint).toHaveText('Drag to select a region · Space for a window · Escape to cancel');
  await page.mouse.move(200, 150);
  await page.keyboard.press('Space');
  await expect(hint).toHaveText('Click a window to capture it · Space for a region · Escape to cancel');
  // Under the pointer already, so framed already, without a move.
  const pick = page.locator('.pick');
  await expect(pick).toBeVisible();
  expect(await pick.boundingBox()).toEqual({ x: 60, y: 50, width: 400, height: 300 });
  await expect(page.locator('.pick-name')).toHaveText('Safari — Apple');
  await expect(page.locator('.pick-size')).toHaveText('400 × 300');
  await expect(page.locator('.veil')).toHaveClass(/clear/);       // the frame's own shadow dims the rest

  await page.mouse.move(400, 300);                                // where the two overlap: the one in front
  await expect(page.locator('.pick-name')).toHaveText('Safari — Apple');
  await page.mouse.move(600, 450);                                // an untitled window goes by its app
  await expect(page.locator('.pick-name')).toHaveText('Notes');
  expect(await pick.boundingBox()).toEqual({ x: 340, y: 220, width: 380, height: 300 });

  await page.mouse.move(780, 20);                                 // the desktop: nothing to take
  await expect(pick).toBeHidden();
  await expect(page.locator('.veil')).not.toHaveClass(/clear/);
  await page.mouse.click(780, 20);
  expect((await sent(page)).map(call => call.cmd)).not.toContain('capture_window');

  await page.mouse.click(600, 450);
  expect((await waitFor(page, 'capture_window')).args).toEqual({ id: 12, delay: 0 });
});

test('Capture Window opens picking, the window under a pointer that has not moved already framed, and Return takes it', async ({ page }) => {
  await picking(page, { mode: 'window', pointer: { x: 200, y: 150 }, delay: 5 });
  await expect(page.locator('.pick-name')).toHaveText('Safari — Apple');
  await page.keyboard.press('Enter');
  // The delay armed in Capture's menu holds for a window as for a region.
  expect((await waitFor(page, 'capture_window')).args).toEqual({ id: 11, delay: 5 });
});

test('on a display to one side, windows are found in global points, and one hanging off it is named where it shows', async ({ page }) => {
  await picking(page, {
    mode: 'window', display: { x: 800, y: 0, width: 800, height: 580, scale: 2 },
    windows: [{ id: 21, app: 'Code', title: 'main.ts', x: 700, y: 100, width: 400, height: 300 }],
  });
  await page.mouse.move(50, 200);
  expect(await page.locator('.pick').boundingBox()).toEqual({ x: -100, y: 100, width: 400, height: 300 });
  // In the middle of the part on this display, 0 to 300 across, not of the whole window.
  const label = (await page.locator('.pick-label').boundingBox())!;
  expect(label.x + label.width / 2).toBeCloseTo(150, 0);
  expect(label.y + label.height / 2).toBeCloseTo(250, 0);
  await page.mouse.click(50, 200);
  expect((await waitFor(page, 'capture_window')).args).toEqual({ id: 21, delay: 0 });
});

test('Space goes back to a region, where a drag selects as before', async ({ page }) => {
  await picking(page, { mode: 'window', pointer: { x: 200, y: 150 } });
  await page.keyboard.press('Space');
  await expect(page.locator('.hint')).toHaveText(/^Drag to select a region/);
  await expect(page.locator('.pick')).toBeHidden();
  await select(page, [120, 100], [520, 400]);
  await expect(page.locator('.panel')).toBeVisible();
  await expect(page.locator('.w')).toHaveValue('400');
});

test('Space on a focused button presses it, rather than switching to windows', async ({ page }) => {
  await picking(page);
  await select(page, [120, 100], [520, 400]);
  const lock = page.locator('.lock');
  await lock.click();
  await expect(lock).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Space');
  await expect(lock).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.hint')).toHaveText(/^Drag to select a region/);
  await expect(page.locator('.panel')).toBeVisible();
});

test('a switch made on one display is made on every display', async ({ page }) => {
  await picking(page);
  await page.keyboard.press('Space');
  await expect.poll(() => emitted(page)).toContainEqual({ event: 'selection-mode', payload: { mode: 'window' } });
  // And one made on another display is followed here.
  await emit(page, 'selection-mode', { mode: 'region' });
  await expect(page.locator('.hint')).toHaveText(/^Drag to select a region/);
});

test('a window that has closed says so, and another can be picked', async ({ page }) => {
  const closed = 'That window has closed. Pick another, or press Escape.';
  await picking(page, { mode: 'window', fails: { capture_window: closed } });
  await page.mouse.click(200, 150);
  await expect(page.locator('.hint')).toHaveText(closed);
  await clear(page);
  await page.mouse.click(600, 450);
  expect((await waitFor(page, 'capture_window')).args).toEqual({ id: 12, delay: 0 });
});

test('with no windows to pick, window mode says so', async ({ page }) => {
  await picking(page, { mode: 'window', windows: [] });
  await expect(page.locator('.hint')).toHaveText('No windows to capture · Space for a region · Escape to cancel');
  await page.mouse.click(200, 150);
  expect((await sent(page)).map(call => call.cmd)).not.toContain('capture_window');
});
