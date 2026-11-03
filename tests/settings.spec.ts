import { test, expect, type Page } from '@playwright/test';
import { installBridge, waitFor, clear, sent } from './bridge';

/** The settings window, against the real invoke path: each control sends the
 *  command it should, with the argument Rust expects, and shows what Rust
 *  answers rather than what was asked for. */

const SAVED = { appearance: 'light', shortcut: 'Super+Alt+Digit4' };
/** Settings is in tabs; a row can be used once its tab is showing. */
const tab = (page: Page, name: string) => page.getByRole('tab', { name }).click();

test('opens showing what is saved, not the defaults', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: true } });
  await page.goto('/settings.html');
  await expect(page.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('.login')).toBeChecked();
  await tab(page, 'Capture');
  await expect(page.locator('.recorder[data-way="region"] kbd')).toHaveText('⌥⌘4');
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
  await tab(page, 'Capture');
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
  await tab(page, 'Capture');
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
  await tab(page, 'Capture');
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
  await tab(page, 'Capture');
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

test('updates: the automatic check shows what Rust saved, and Check for updates looks right there', async ({ page }) => {
  await installBridge(page, { returns: {
    get_settings: { ...SAVED, checkUpdates: true }, login_enabled: false,
    set_auto_update: { ...SAVED, checkUpdates: false }, check_for_update: null,
  } });
  await page.goto('/settings.html');
  const automatic = page.getByRole('checkbox', { name: 'Check for updates automatically' });
  await expect(automatic).toBeChecked();
  await automatic.click();
  expect((await waitFor(page, 'set_auto_update')).args).toEqual({ enabled: false });
  await expect(automatic).not.toBeChecked();
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await waitFor(page, 'check_for_update');
  await expect(page.locator('.update-state')).toHaveText('Up to date');
});

test('updates: a newer Mark found is said, and Update… opens Software Update to install it', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false, check_for_update: { version: '9.9.9', notes: '' } } });
  await page.goto('/settings.html');
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(page.locator('.update-state')).toHaveText('Mark 9.9.9 is available.');
  await clear(page);
  await page.getByRole('button', { name: 'Update…' }).click();
  await waitFor(page, 'open_updates');
});

test('updates: one a check already found is offered as Settings opens', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false, pending_update: { version: '9.9.9', notes: '' } } });
  await page.goto('/settings.html');
  await expect(page.getByRole('button', { name: 'Update…' })).toBeVisible();
  await expect(page.locator('.update-state')).toHaveText('Mark 9.9.9 is available.');
});

test('updates: a check that fails says why', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false }, fails: { check_for_update: 'The network is down.' } });
  await page.goto('/settings.html');
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(page.locator('.update-state')).toHaveText('The network is down.');
  await expect(page.locator('.update-state')).toHaveClass(/failed/);
});

test('updates can install themselves: turning it on turns on looking, and turning looking off turns it off', async ({ page }) => {
  await installBridge(page, { returns: {
    get_settings: { ...SAVED, checkUpdates: false, installUpdates: false }, login_enabled: false,
    set_install_updates: { ...SAVED, checkUpdates: true, installUpdates: true },
    set_auto_update: { ...SAVED, checkUpdates: false, installUpdates: false },
  } });
  await page.goto('/settings.html');
  const install = page.getByRole('checkbox', { name: 'Install updates automatically' });
  const look = page.getByRole('checkbox', { name: 'Check for updates automatically' });
  await expect(install).not.toBeChecked();
  await install.click();
  expect((await waitFor(page, 'set_install_updates')).args).toEqual({ enabled: true });
  await expect(install).toBeChecked();
  await expect(look).toBeChecked();
  await look.click();
  expect((await waitFor(page, 'set_auto_update')).args).toEqual({ enabled: false });
  await expect(install).not.toBeChecked();
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
  await tab(page, 'Capture');
  const thumbnail = page.getByLabel('Show a thumbnail instead of the editor');
  await expect(thumbnail).not.toBeChecked();
  await thumbnail.check();
  expect((await waitFor(page, 'set_after_capture')).args).toEqual({ value: 'thumbnail' });
  await expect(thumbnail).toBeChecked();
});

test('a refused thumbnail choice says why and puts the box back', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false }, fails: { set_after_capture: 'Not here.' } });
  await page.goto('/settings.html');
  await tab(page, 'Capture');
  const thumbnail = page.getByLabel('Show a thumbnail instead of the editor');
  await thumbnail.check();
  await expect(page.getByText('Not here.')).toBeVisible();
  await expect(thumbnail).not.toBeChecked();
});

test('AI tools: the switch is sent, and the tool picked is added its own way', async ({ page }) => {
  const agents = [
    { name: 'Claude Code', group: 'Command line', kind: 'command', text: "claude mcp add --scope user mark -- '/Applications/Mark.app/Contents/MacOS/mark' --mcp",
      hint: 'In Terminal, and in VS Code and Cursor too.' },
    { name: 'Claude Desktop', group: 'Apps', kind: 'config', place: '~/Library/Application Support/Claude/claude_desktop_config.json',
      text: '{\n  "mcpServers": {}\n}', restart: true },
    { name: 'ChatGPT (Codex)', group: 'Apps', kind: 'form', text: '/Applications/Mark.app/Contents/MacOS/mark',
      steps: 'In ChatGPT, open Settings › MCP servers › Add server, with the argument --mcp.' },
    { name: 'Cursor', group: 'Editors', kind: 'link', url: 'cursor://anysphere.cursor-deeplink/mcp/install?name=mark&config=e30',
      hint: 'For Cursor’s own Agent. Using Claude Code in Cursor? Pick Claude Code.' },
  ];
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false, set_mcp: { ...SAVED, mcp: false }, mcp_setup: agents } });
  await page.goto('/settings.html');
  await tab(page, 'AI tools');
  const allow = page.getByLabel('Let AI tools ask for screenshots');
  await expect(allow).toBeChecked();
  await allow.uncheck();
  expect((await waitFor(page, 'set_mcp')).args).toEqual({ enabled: false });
  await expect(allow).not.toBeChecked();

  // Listed under their groups, Claude Code first; a command is copied for Terminal.
  const pick = page.getByRole('combobox', { name: 'Add Mark to' });
  const add = page.locator('.add-agent');
  await expect(pick).toBeEnabled();
  await expect(pick.locator('optgroup')).toHaveCount(3);
  await expect(pick).toHaveValue('Claude Code');
  await expect(add).toHaveText('Copy Command');
  await clear(page);
  await add.click();
  expect((await waitFor(page, 'copy_text')).args).toEqual({ text: agents[0].text });
  await expect(page.getByText('Copied. Paste it into Terminal and press Return.')).toBeVisible();

  await expect(page.locator('.agent-hint')).toHaveText('In Terminal, and in VS Code and Cursor too.');

  // A tool with a link of its own is opened, by name: Rust makes the link.
  // Which of the editor's agents that is for is said before it is opened.
  await pick.selectOption('Cursor');
  await expect(page.locator('.agent-hint')).toHaveText('For Cursor’s own Agent. Using Claude Code in Cursor? Pick Claude Code.');
  await expect(add).toHaveText('Add to Cursor');
  await clear(page);
  await add.click();
  expect((await waitFor(page, 'add_to_agent')).args).toEqual({ name: 'Cursor' });
  await expect(page.getByText('Cursor opens and asks whether to add Mark.')).toBeVisible();

  // A settings file: its lines are copied, and the note says where they go.
  await pick.selectOption('Claude Desktop');
  await expect(add).toHaveText('Copy Config');
  await expect(page.locator('.agent-hint')).toHaveText('Copies the lines for the tool’s settings file.');
  await clear(page);
  await add.click();
  expect((await waitFor(page, 'copy_text')).args).toEqual({ text: agents[1].text });
  await expect(page.getByText('Copied. Add it to ~/Library/Application Support/Claude/claude_desktop_config.json, then quit and reopen Claude Desktop.')).toBeVisible();

  // A form in the tool's own settings: Mark's path is copied, and the steps said.
  await pick.selectOption('ChatGPT (Codex)');
  await expect(add).toHaveText('Copy Path');
  await clear(page);
  await add.click();
  expect((await waitFor(page, 'copy_text')).args).toEqual({ text: '/Applications/Mark.app/Contents/MacOS/mark' });
  await expect(page.locator('.mcp-note')).toHaveText('Copied Mark’s path. In ChatGPT, open Settings › MCP servers › Add server, with the argument -\u2060-\u2060mcp.');

  // The guide opens at the tool picked.
  await clear(page);
  await page.getByRole('button', { name: 'How to set it up and use it' }).click();
  expect((await waitFor(page, 'open_guide')).args).toEqual({ name: 'ChatGPT (Codex)' });
});

test('a Mark running from a temporary copy says to move it first, and offers nothing to add', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false },
    fails: { mcp_setup: 'Move Mark to your Applications folder first: macOS is running it from a temporary copy.' } });
  await page.goto('/settings.html');
  await tab(page, 'AI tools');
  await expect(page.getByText(/Move Mark to your Applications folder first/)).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Add Mark to' })).toBeDisabled();
  await expect(page.locator('.add-agent')).toBeDisabled();
});

test('Mark is in the Dock unless Settings says otherwise', async ({ page }) => {
  const saved = { appearance: 'dark', shortcut: 'Super+Digit4' };
  await installBridge(page, { returns: { get_settings: saved, login_enabled: false, set_show_in_dock: { ...saved, showInDock: false } } });
  await page.goto('/settings.html');
  const dock = page.getByRole('checkbox', { name: 'Show Mark in the Dock' });
  // A settings file from before the choice: in the Dock.
  await expect(dock).toBeChecked({ timeout: 15_000 });
  await dock.uncheck();
  expect((await waitFor(page, 'set_show_in_dock')).args).toEqual({ show: false });
  await expect(dock).not.toBeChecked();
});

test('tabs: one page at a time, the window the same height on each, and the tab kept for next time', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false, recording_supported: true } });
  await page.goto('/settings.html');
  const general = page.getByRole('tab', { name: 'General' });
  await expect(general).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Recording' })).toBeVisible();
  const height = async () => (await page.locator('#settings').boundingBox())!.height;
  const first = await height();
  for (const name of ['Capture', 'Recording', 'AI tools']) {
    await tab(page, name);
    await expect(page.getByRole('tabpanel')).toHaveCount(1);
    await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', `tab-${name === 'AI tools' ? 'ai' : name.toLowerCase()}`);
    expect(await height()).toBe(first);
  }
  await expect(page.locator('.dock')).toBeHidden();
  // Left and right step along the tabs.
  await page.getByRole('tab', { name: 'AI tools' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Recording' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Recording' })).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Recording' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.record-mic')).toBeVisible();
});

test('Screen Recording: allowed is said; not allowed offers System Settings, and is looked at again on coming back', async ({ page }) => {
  await installBridge(page, { returns: { get_settings: SAVED, login_enabled: false, screen_access_granted: false } });
  await page.goto('/settings.html');
  const open = page.getByRole('button', { name: 'Open System Settings…' });
  await expect(open).toBeVisible();
  await expect(page.locator('.screen-allowed')).toBeHidden();
  await open.click();
  await waitFor(page, 'open_screen_settings');
  // Allowed in System Settings, then back to Settings.
  await page.evaluate(() => { (window as any).__bridge.returns.screen_access_granted = true; window.dispatchEvent(new Event('focus')); });
  await expect(page.locator('.screen-allowed')).toHaveText('Allowed');
  await expect(open).toBeHidden();
});
