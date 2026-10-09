import { test, expect } from '@playwright/test';
import { installBridge, waitFor, clear, sent } from './bridge';

/** The settings window, against the real invoke path: each control sends the
 *  command it should, with the argument Rust expects, and shows what Rust
 *  answers rather than what was asked for. */

const SAVED = { appearance: 'light', shortcut: 'Super+Alt+Digit4' };

test('opens showing what is saved, not the defaults', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: true } });
  await page.goto('/settings.html');
  await expect(page.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('.recorder[data-way="region"] kbd')).toHaveText('⌥⌘4');
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
  await page.locator('.recorder[data-way="region"]').click();
  await expect(page.locator('.recorder[data-way="region"]')).toHaveClass(/recording/);
  await expect(page.locator('.recorder[data-way="region"] kbd')).toHaveText('Press keys…');
  await page.keyboard.press('m');
  await expect(page.locator('.shortcut-note')).toContainText('⌘, ⌃ or ⌥');
  await expect(page.locator('.recorder[data-way="region"]')).toHaveClass(/recording/);          // still listening
  await page.keyboard.press('Meta+Shift+m');
  expect((await waitFor(page, 'set_shortcut')).args).toEqual({ shortcut: 'Shift+Super+KeyM' });
  await expect(page.locator('.recorder[data-way="region"] kbd')).toHaveText('⇧⌘M');
  await expect(page.locator('.recorder[data-way="region"]')).not.toHaveClass(/recording/);
});

test('a shortcut Rust cannot take is reported and the old one stays', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false }, fails: { set_shortcut: 'Something else on this Mac already uses that shortcut.' } });
  await page.goto('/settings.html');
  await page.locator('.recorder[data-way="region"]').click();
  await page.keyboard.press('Meta+Alt+k');
  await expect(page.locator('.shortcut-note')).toContainText('already uses');
  await expect(page.locator('.recorder[data-way="region"] kbd')).toHaveText('⌥⌘4');
});

// The other three ways in each take a shortcut of their own, and start with none.
test('each way in can have its own shortcut, cleared again with ⌫', async ({ page }) => {
  const window = { ...SAVED, shortcuts: { window: 'Alt+Super+Digit5' } };
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false, set_shortcut: window } });
  await page.goto('/settings.html');
  const recorder = (way: string) => page.locator(`.recorder[data-way="${way}"]`);
  await expect(recorder('window')).toHaveAccessibleName('Window');
  for (const way of ['window', 'display', 'timed']) await expect(recorder(way).locator('kbd')).toHaveText('None');

  await recorder('window').click();
  await page.keyboard.press('Meta+Alt+5');
  expect((await waitFor(page, 'set_shortcut')).args).toEqual({ shortcut: 'Alt+Super+Digit5', mode: 'window' });
  await expect(recorder('window').locator('kbd')).toHaveText('⌥⌘5');
  await expect(recorder('region').locator('kbd')).toHaveText('⌥⌘4');            // Region's untouched

  await clear(page);
  await recorder('window').click();
  await page.keyboard.press('Backspace');                                       // ⌫ clears, not a default
  expect((await waitFor(page, 'set_shortcut')).args).toEqual({ shortcut: '', mode: 'window' });
});

test('a key another way already has is refused, and says which', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false }, fails: { set_shortcut: 'Capture Region already uses ⌥⌘4.' } });
  await page.goto('/settings.html');
  await page.locator('.recorder[data-way="timed"]').click();
  await page.keyboard.press('Meta+Alt+4');
  await expect(page.locator('.shortcut-note')).toHaveText('Capture Region already uses ⌥⌘4.');
  await expect(page.locator('.recorder[data-way="timed"] kbd')).toHaveText('None');
});

test('login follows what macOS says, not the checkbox', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false, set_login: false } });
  await page.goto('/settings.html');
  await page.locator('.login').check();
  expect((await waitFor(page, 'set_login')).args).toEqual({ enabled: true });
  await expect(page.locator('.login')).not.toBeChecked();   // macOS said no
});

test('updates: the automatic check shows what Rust saved, and Check Now asks for a check', async ({ page }) => {
  await installBridge(page, { returns: {
    get_settings: { ...SAVED, checkUpdates: true }, login_enabled: false,
    set_auto_update: { ...SAVED, checkUpdates: false },
  } });
  await page.goto('/settings.html');
  const automatic = page.getByRole('checkbox', { name: 'Check for updates automatically' });
  await expect(automatic).toBeChecked();
  await automatic.click();
  expect((await waitFor(page, 'set_auto_update')).args).toEqual({ enabled: false });
  await expect(automatic).not.toBeChecked();
  await page.getByRole('button', { name: 'Check Now' }).click();
  await waitFor(page, 'open_updates');
});

test('a settings file from before updates shows them switched on', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false } });
  await page.goto('/settings.html');
  await expect(page.getByRole('checkbox', { name: 'Check for updates automatically' })).toBeChecked();
});

test('the editor shows the saved shortcut, and follows a change', async ({ page }) => {
  await installBridge(page, { capture: null, returns: { get_settings: SAVED } });
  await page.goto('/');
  await expect(page.locator('.start kbd')).toHaveText('⌥⌘4');
  await page.locator('.capture-more').click();
  await expect(page.locator('.capture-menu [data-mode="region"] kbd')).toHaveText('⌥⌘4');
});

test('the editor shows each way\'s shortcut, and Timed its delay until it has one', async ({ page }) => {
  await installBridge(page, { capture: null, returns: { get_settings: { ...SAVED, shortcuts: { window: 'Alt+Super+Digit5', display: 'Shift+Super+Digit3' } } } });
  await page.goto('/');
  const tile = (way: string) => page.locator(`[data-start="${way}"] kbd`);
  await expect(tile('window')).toHaveText('⌥⌘5');
  await expect(tile('display')).toHaveText('⇧⌘3');
  await expect(tile('timed')).toHaveText('5s');
  await page.locator('.capture-more').click();
  await expect(page.locator('.capture-menu [data-mode="window"] kbd')).toHaveText('⌥⌘5');
  await expect(page.locator('.capture-menu [data-mode="timed"] kbd')).toHaveText('5s');
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

test('the thumbnail choice is sent, and shows what Rust answers', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false, set_after_capture: { ...SAVED, afterCapture: 'thumbnail' } } });
  await page.goto('/settings.html');
  const thumbnail = page.getByLabel('Show a thumbnail instead of the editor');
  await expect(thumbnail).not.toBeChecked();
  await thumbnail.check();
  expect((await waitFor(page, 'set_after_capture')).args).toEqual({ value: 'thumbnail' });
  await expect(thumbnail).toBeChecked();
});

test('a refused thumbnail choice says why and puts the box back', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false }, fails: { set_after_capture: 'Not here.' } });
  await page.goto('/settings.html');
  const thumbnail = page.getByLabel('Show a thumbnail instead of the editor');
  await thumbnail.check();
  await expect(page.getByText('Not here.')).toBeVisible();
  await expect(thumbnail).not.toBeChecked();
});

test('AI tools: the switch is sent, and each copy button copies what Rust made and says where it goes', async ({ page }) => {
  const setup = { claudeCode: "claude mcp add --scope user mark -- '/Applications/Mark.app/Contents/MacOS/mark' --mcp",
                  claudeDesktop: '{\n  "mcpServers": {\n    "mark": {}\n  }\n}' };
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false, set_mcp: { ...SAVED, mcp: false }, mcp_setup: setup } });
  await page.goto('/settings.html');
  const allow = page.getByLabel('Let AI tools ask for screenshots');
  await expect(allow).toBeChecked();
  await allow.uncheck();
  expect((await waitFor(page, 'set_mcp')).args).toEqual({ enabled: false });
  await expect(allow).not.toBeChecked();
  await clear(page);
  await page.getByRole('button', { name: 'Copy Claude Code Command' }).click();
  expect((await waitFor(page, 'copy_text')).args).toEqual({ text: setup.claudeCode });
  await expect(page.getByText(/Paste it into Terminal/)).toBeVisible();
  await clear(page);
  await page.getByRole('button', { name: 'Copy Claude Desktop Config' }).click();
  expect((await waitFor(page, 'copy_text')).args).toEqual({ text: setup.claudeDesktop });
  await expect(page.getByText(/claude_desktop_config\.json/)).toBeVisible();
});

test('a Mark running from a temporary copy says to move it first, and copies nothing', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false },
    fails: { mcp_setup: 'Move Mark to your Applications folder first: macOS is running it from a temporary copy.' } });
  await page.goto('/settings.html');
  await page.getByRole('button', { name: 'Copy Claude Code Command' }).click();
  await expect(page.getByText(/Move Mark to your Applications folder first/)).toBeVisible();
  expect((await sent(page)).map(call => call.cmd)).not.toContain('copy_text');
});
