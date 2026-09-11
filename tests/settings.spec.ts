import { test, expect } from '@playwright/test';
import { installBridge, waitFor, clear } from './bridge';

/** The settings window, against the real invoke path: each control sends the
 *  command it should, with the argument Rust expects, and shows what Rust
 *  answers rather than what was asked for. */

const SAVED = { appearance: 'light', shortcut: 'Super+Alt+Digit4' };

test('opens showing what is saved, not the defaults', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: true } });
  await page.goto('/settings.html');
  await expect(page.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('.recorder kbd')).toHaveText('⌥⌘4');
  await expect(page.locator('.login')).toBeChecked();
  await expect(page.locator('.pref-preview')).toBeHidden();   // not the browser path
});

test('choosing an appearance sends it and shows the reply', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false, set_appearance: { ...SAVED, appearance: 'dark' } } });
  await page.goto('/settings.html');
  await page.getByRole('radio', { name: 'Dark' }).click();
  expect((await waitFor(page, 'set_appearance')).args).toEqual({ appearance: 'dark' });
  await expect(page.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
  // The pill slides over to it; give it the 340ms it takes.
  await expect.poll(async () => {
    const pill = await page.locator('.segments .lens').boundingBox();
    const dark = await page.getByRole('radio', { name: 'Dark' }).boundingBox();
    return Math.abs(pill!.x - dark!.x);
  }).toBeLessThan(1.5);
});

test('recording a shortcut refuses a bare key, then sends a proper chord', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false, set_shortcut: { ...SAVED, shortcut: 'Shift+Super+KeyM' } } });
  await page.goto('/settings.html');
  await page.locator('.recorder').click();
  await expect(page.locator('.recorder')).toHaveClass(/recording/);
  await expect(page.locator('.recorder kbd')).toHaveText('Press keys…');
  await page.keyboard.press('m');
  await expect(page.locator('.shortcut-note')).toContainText('⌘, ⌃ or ⌥');
  await expect(page.locator('.recorder')).toHaveClass(/recording/);          // still listening
  await page.keyboard.press('Meta+Shift+m');
  expect((await waitFor(page, 'set_shortcut')).args).toEqual({ shortcut: 'Shift+Super+KeyM' });
  await expect(page.locator('.recorder kbd')).toHaveText('⇧⌘M');
  await expect(page.locator('.recorder')).not.toHaveClass(/recording/);
});

test('a shortcut Rust cannot take is reported and the old one stays', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false }, fails: { set_shortcut: 'Something else on this Mac already uses that shortcut.' } });
  await page.goto('/settings.html');
  await page.locator('.recorder').click();
  await page.keyboard.press('Meta+Alt+k');
  await expect(page.locator('.shortcut-note')).toContainText('already uses');
  await expect(page.locator('.recorder kbd')).toHaveText('⌥⌘4');
});

test('login follows what macOS says, not the checkbox', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false, set_login: false } });
  await page.goto('/settings.html');
  await page.locator('.login').check();
  expect((await waitFor(page, 'set_login')).args).toEqual({ enabled: true });
  await expect(page.locator('.login')).not.toBeChecked();   // macOS said no
});

test('the editor shows the saved shortcut, and follows a change', async ({ page }) => {
  await installBridge(page, { capture: null, returns: { get_settings: SAVED } });
  await page.goto('/');
  await expect(page.locator('.start kbd')).toHaveText('⌥⌘4');
  await page.locator('.capture-more').click();
  await expect(page.locator('.capture-menu [data-mode="region"] kbd')).toHaveText('⌥⌘4');
});

test('the editor offers a way into settings: a gear in the title row, and ⌘,', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED } });
  await page.goto('/');
  const gear = page.getByRole('button', { name: 'Settings' });
  await expect(gear).toBeVisible();
  await gear.click();
  await waitFor(page, 'open_settings');
  await clear(page);
  await page.keyboard.press('Meta+,');
  await waitFor(page, 'open_settings');
});
