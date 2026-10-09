import { test, expect } from '@playwright/test';
import { installBridge, waitFor, clear, emit, sent } from './bridge';

/** Software Update, against the real invoke path: each answer sends the
 *  command it should, and the window says what Rust reports is happening. */

const OFFER = {
  version: '0.5.0', current: '0.4.5',
  notes: "## What's new\n\n- **Copy and paste a mark.** Select it, ⌘C, ⌘V.\n- <b>not markup</b>",
};

test('an update Mark found by itself is offered with its notes, without checking again', async ({ page }) => {
  await installBridge(page, { returns: { pending_update: OFFER } });
  await page.goto('/update.html');
  await expect(page.getByRole('heading', { name: 'A new version of Mark is available' })).toBeVisible();
  await expect(page.getByText('Mark 0.5.0 is ready to install. You have 0.4.5.')).toBeVisible();
  const notes = page.getByLabel("What's new");
  await expect(notes.locator('h3')).toHaveText("What's new");
  await expect(notes.locator('li strong')).toHaveText('Copy and paste a mark.');
  await expect(notes.locator('b')).toHaveCount(0);                 // notes are only ever text
  await expect(notes).toContainText('<b>not markup</b>');
  await expect(page.getByRole('button', { name: 'Install and Relaunch' })).toBeFocused();
  expect((await sent(page)).map(call => call.cmd)).not.toContain('check_for_update');
});

test('installing shows the download, then the install, as Rust reports them', async ({ page }) => {
  await installBridge(page, { returns: { pending_update: OFFER } });
  await page.goto('/update.html');
  await page.getByRole('button', { name: 'Install and Relaunch' }).click();
  await waitFor(page, 'install_update');
  await expect(page.getByRole('heading', { name: 'Downloading Mark 0.5.0…' })).toBeVisible();

  await emit(page, 'update-progress', { done: 3_800_000, total: 7_600_000 });
  await expect(page.getByText('3.8 MB of 7.6 MB')).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3800000');
  // Mid-download there is nothing to put off, so Escape leaves it be.
  await page.keyboard.press('Escape');
  expect((await sent(page)).map(call => call.cmd)).not.toContain('plugin:window|close');

  await emit(page, 'update-installing');
  await expect(page.getByRole('heading', { name: 'Installing Mark 0.5.0…' })).toBeVisible();
  await expect(page.getByText('Mark will reopen by itself in a moment.')).toBeVisible();
});

test('Skip This Version remembers which version, and closes', async ({ page }) => {
  await installBridge(page, { returns: { pending_update: OFFER } });
  await page.goto('/update.html');
  await page.getByRole('button', { name: 'Skip This Version' }).click();
  expect((await waitFor(page, 'skip_update')).args).toEqual({ version: '0.5.0' });
  await waitFor(page, 'plugin:window|close');
  expect((await sent(page)).map(call => call.cmd)).not.toContain('install_update');
});

test('Remind Me Later only closes: nothing is skipped, nothing installed', async ({ page }) => {
  await installBridge(page, { returns: { pending_update: OFFER } });
  await page.goto('/update.html');
  await page.getByRole('button', { name: 'Remind Me Later' }).click();
  await waitFor(page, 'plugin:window|close');
  const commands = (await sent(page)).map(call => call.cmd);
  expect(commands).not.toContain('skip_update');
  expect(commands).not.toContain('install_update');
});

test('a check asked for really checks, and says when Mark is up to date', async ({ page }) => {
  await installBridge(page, { returns: { pending_update: OFFER, check_for_update: null, 'plugin:app|version': '0.4.5' } });
  await page.goto('/update.html?check');
  await expect(page.getByRole('heading', { name: "You're up to date" })).toBeVisible();
  await expect(page.getByText('Mark 0.4.5 is the newest version.')).toBeVisible();
  // Asked to check, it asks, rather than showing whatever an earlier check left.
  expect((await sent(page)).map(call => call.cmd)).not.toContain('pending_update');
  await page.keyboard.press('Enter');                               // OK has the focus
  await waitFor(page, 'plugin:window|close');
});

test('a check that cannot reach the server says so plainly, and can try again', async ({ page }) => {
  await installBridge(page, {
    returns: { 'plugin:app|version': '0.4.5' },
    fails: { check_for_update: 'error sending request for url (https://mark.tommymassaro.com/updates/latest.json)' },
  });
  await page.goto('/update.html?check');
  await expect(page.getByRole('heading', { name: "Mark couldn't check for updates" })).toBeVisible();
  await expect(page.getByText("Mark couldn't reach its update server. Check your connection, then try again.")).toBeVisible();
  await expect(page.getByText(/error sending request/)).toBeVisible();   // the updater's own words, underneath
  await clear(page);
  await page.getByRole('button', { name: 'Try Again' }).click();
  await waitFor(page, 'check_for_update');
});

test('an install refused for its signature says why', async ({ page }) => {
  await installBridge(page, { returns: { pending_update: OFFER }, fails: { install_update: 'signature verification failed' } });
  await page.goto('/update.html');
  await page.getByRole('button', { name: 'Install and Relaunch' }).click();
  await expect(page.getByRole('heading', { name: "Mark couldn't install the update" })).toBeVisible();
  await expect(page.getByText("The download wasn't signed by Mark's key, so it was not installed.")).toBeVisible();
  await clear(page);
  await page.getByRole('button', { name: 'Try Again' }).click();
  await waitFor(page, 'install_update');
});

// The window opens before the check has answered, so what it shows grows
// after it opened. It asks to grow by exactly what the page is short of.
test('the window grows to fit what it shows', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 128 });           // what the page can see
  await installBridge(page, { returns: {
    check_for_update: null, 'plugin:app|version': '0.4.5',
    'plugin:window|inner_size': { width: 1040, height: 320 },      // 160 points: the strip under the title bar too
    'plugin:window|scale_factor': 2,
  } });
  await page.goto('/update.html?check');
  await expect(page.getByRole('heading', { name: "You're up to date" })).toBeVisible();
  const needs = await page.evaluate(() => Math.ceil(document.querySelector('#update')!.getBoundingClientRect().height));
  expect(needs).toBeGreaterThan(128);                                 // so it really is short
  await expect.poll(async () => {
    const sizes = (await sent(page)).filter(call => call.cmd === 'plugin:window|set_size');
    return sizes.length ? JSON.stringify(sizes[sizes.length - 1].args) : '';
  }).toContain(`"height":${160 + needs - 128}`);
});

// Software Update opens hidden, so it is never seen at one size jumping to
// another. It shows itself once what it says first is in and the window fits
// it -- sized, then centred at that size, then shown and brought forward.
test('a new window shows itself only once it fits what it shows, centred', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 152 });           // what the page can see
  await installBridge(page, { returns: {
    pending_update: OFFER,
    'plugin:window|inner_size': { width: 1040, height: 368 },      // 184 points: the strip under the title bar too
    'plugin:window|scale_factor': 2,
  } });
  await page.goto('/update.html');
  await expect(page.getByRole('heading', { name: 'A new version of Mark is available' })).toBeVisible();
  const needs = await page.evaluate(() => Math.ceil(document.querySelector('#update')!.getBoundingClientRect().height));
  expect(needs).toBeGreaterThan(152);                                 // the notes make it taller than it opened
  await waitFor(page, 'plugin:window|set_focus');
  const window = (await sent(page)).filter(call => call.cmd.startsWith('plugin:window|'));
  const order = window.map(call => call.cmd.replace('plugin:window|', '')).filter(cmd => ['set_size', 'center', 'show', 'set_focus'].includes(cmd));
  expect(order).toEqual(['set_size', 'center', 'show', 'set_focus']);
  expect(JSON.stringify(window.find(call => call.cmd === 'plugin:window|set_size')!.args)).toContain(`"height":${184 + needs - 152}`);
});

// Asked to check, it shows straight away -- the check can take a while -- and
// in the shape of the answers it will turn into, so nothing jumps when one comes.
test('checking shows at once, the height of its answers, and Cancel puts it away', async ({ page }) => {
  await installBridge(page, { holds: ['check_for_update'] });
  await page.goto('/update.html?check');
  await expect(page.getByRole('heading', { name: 'Checking for updates…' })).toBeVisible();
  await waitFor(page, 'plugin:window|show');
  const checking = await page.evaluate(() => document.querySelector('#update')!.getBoundingClientRect().height);

  const answers = await page.context().newPage();
  await installBridge(answers, { returns: { check_for_update: null, 'plugin:app|version': '0.5.0' } });
  await answers.goto('/update.html?check');
  await expect(answers.getByRole('heading', { name: "You're up to date" })).toBeVisible();
  expect(await answers.evaluate(() => document.querySelector('#update')!.getBoundingClientRect().height)).toBe(checking);
  await answers.close();

  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Enter');
  await waitFor(page, 'plugin:window|close');
});

test('the window shows itself once, not again for every answer', async ({ page }) => {
  await installBridge(page, { returns: { check_for_update: OFFER } });
  await page.goto('/update.html?check');
  await expect(page.getByRole('heading', { name: 'A new version of Mark is available' })).toBeVisible();
  await waitFor(page, 'plugin:window|show');
  await page.getByRole('button', { name: 'Install and Relaunch' }).click();
  await waitFor(page, 'install_update');
  expect((await sent(page)).filter(call => call.cmd === 'plugin:window|show')).toHaveLength(1);
});
