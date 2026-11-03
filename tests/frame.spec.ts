import { test, expect, type Page } from '@playwright/test';
import { installBridge, sent, waitFor, clear, setBridge, emit } from './bridge';
import { CAPTURE } from './fixture';
import { DEFAULT_FRAME, frameGeometry, type FrameStyle } from '../src/frame';

/** Frame, against the real export path: what the panel sets is what the canvas
 *  shows, and what the canvas shows is what is copied -- the same geometry,
 *  checked pixel by pixel in the PNG that reaches Rust. */

const frameButton = (page: Page) => page.getByRole('button', { name: 'Frame', exact: true });
const frameSwitch = (page: Page) => page.getByRole('switch', { name: 'Frame the image' });
/** A background, from the panel: the toolbar has a White too, for drawing in. */
const background = (page: Page, name: string) => page.locator('.frame-panel').getByRole('radio', { name, exact: true });
/** What goes round it: None, Window, Browser, Phone or Tablet. */
const device = (page: Page, name: string) => page.locator('.frame-panel .devices').getByRole('radio', { name, exact: true });

/** A slider moved, as a hand does it: input while it moves, change when let go. */
async function slide(page: Page, key: 'padding' | 'radius' | 'shadow', value: number, letGo = true) {
  await page.locator(`input[data-frame="${key}"]`).evaluate((input: HTMLInputElement, [to, release]) => {
    input.value = String(to);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (release) input.dispatchEvent(new Event('change', { bubbles: true }));
  }, [value, letGo] as const);
}

/** The frame Rust was last asked to keep, once it matches: a save made by an
 *  earlier click can land after a later one is made. */
async function saved(page: Page, frame: Record<string, unknown>) {
  await expect.poll(async () => {
    const last = [...(await sent(page))].reverse().find(call => call.cmd === 'set_frame');
    const kept = (last?.args as { frame?: Record<string, unknown> } | undefined)?.frame ?? {};
    return Object.entries(frame).every(([key, value]) => kept[key] === value);
  }).toBe(true);
}

/** A PNG's size and the RGBA of the pixels asked for. */
function sample(page: Page, png: string, points: [number, number][]) {
  return page.evaluate(async ([source, at]) => {
    const image = new Image();
    image.src = source.startsWith('data:') ? source : `data:image/png;base64,${source}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    return { size: [image.width, image.height], at: at.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data)) };
  }, [png, points] as const);
}

/** Copy, and the PNG that went to Rust for it. */
async function copied(page: Page): Promise<string> {
  await clear(page);
  await page.keyboard.press('Meta+c');
  return (await waitFor(page, 'copy_edited')).args.png as string;
}

test('Frame sets the capture on a background in proportion, and off puts it back exactly as it was', async ({ page }) => {
  await page.goto('/');
  await page.locator('.capture').waitFor();
  const unframed = (await page.locator('.stage').boundingBox())!;

  await frameButton(page).click();
  // Asking for Frame is asking for a frame: it is on as the panel opens.
  await expect(page.locator('.frame-panel')).toBeVisible();
  await expect(frameSwitch(page)).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.canvas')).toHaveClass(/framed/);
  const geometry = frameGeometry(1200, 740, 1, { ...DEFAULT_FRAME, on: true });
  await expect(page.locator('.dimensions')).toHaveText(`${geometry.width} × ${geometry.height} px, framed`);

  const backdrop = (await page.locator('.backdrop').boundingBox())!;
  const stage = (await page.locator('.stage').boundingBox())!;
  // The stage is still the capture's own box, in its own shape, with the same
  // room on every side, and the room is the share of it the export gives.
  expect(stage.width / stage.height).toBeCloseTo(1200 / 740, 2);
  expect(stage.width / backdrop.width).toBeCloseTo(1200 / geometry.width, 3);
  expect(stage.x - backdrop.x).toBeCloseTo(backdrop.x + backdrop.width - stage.x - stage.width, 1);
  expect(stage.y - backdrop.y).toBeCloseTo(backdrop.y + backdrop.height - stage.y - stage.height, 1);

  await frameSwitch(page).click();
  await expect(page.locator('.canvas')).not.toHaveClass(/framed/);
  await expect(page.locator('.dimensions')).toHaveText('1200 × 740 px');
  expect(await page.locator('.stage').boundingBox()).toEqual(unframed);
});

test('at 100% the frame is drawn at the capture\'s own size, room and all', async ({ page }) => {
  await installBridge(page);
  await page.goto('/');
  await page.locator('.capture').waitFor();
  await frameButton(page).click();
  const geometry = frameGeometry(CAPTURE.width, CAPTURE.height, 1, { ...DEFAULT_FRAME, on: true });
  await expect.poll(async () => Math.round((await page.locator('.stage').boundingBox())!.width)).toBe(CAPTURE.width);
  expect(Math.round((await page.locator('.backdrop').boundingBox())!.width)).toBe(geometry.width);
  expect(Math.round((await page.locator('.backdrop').boundingBox())!.height)).toBe(geometry.height);
});

test('a framed copy is the capture on its background, its own pixels untouched in the middle', async ({ page }) => {
  await installBridge(page);
  await page.goto('/');
  await page.locator('.capture').waitFor();
  await frameButton(page).click();
  await background(page, 'White').click();
  await slide(page, 'shadow', 0);
  await page.keyboard.press('Escape');                              // the panel goes; the capture stays
  await expect(page.locator('.frame-panel')).toBeHidden();

  const style: FrameStyle = { ...DEFAULT_FRAME, on: true, background: 'white', shadow: 0 };
  const geometry = frameGeometry(CAPTURE.width, CAPTURE.height, 1, style);
  const png = await copied(page);
  const seen = await sample(page, png, [[0, 0], [geometry.width - 1, geometry.height - 1], [geometry.pad + 120, geometry.pad + 80]]);
  const original = await sample(page, CAPTURE.dataUrl, [[120, 80]]);
  expect(seen.size).toEqual([geometry.width, geometry.height]);
  expect(seen.at[0]).toEqual([255, 255, 255, 255]);                // the background, in both corners
  expect(seen.at[1]).toEqual([255, 255, 255, 255]);
  expect(seen.at[2]).toEqual(original.at[0]);                       // the capture's own pixel, where it was put
});

test('no background leaves the corners clear, and a title bar sits on top with its lights', async ({ page }) => {
  await installBridge(page);
  await page.goto('/');
  await page.locator('.capture').waitFor();
  await frameButton(page).click();
  await background(page, 'No background').click();
  await device(page, 'Window').click();
  await slide(page, 'shadow', 0);
  await page.keyboard.press('Escape');

  const style: FrameStyle = { ...DEFAULT_FRAME, on: true, background: 'clear', shadow: 0, device: 'window' };
  const geometry = frameGeometry(CAPTURE.width, CAPTURE.height, 1, style);
  expect(geometry.bar).toBe(28);
  const seen = await sample(page, await copied(page), [
    [0, 0], [geometry.pad + 20, geometry.pad + 14], [geometry.pad + 120, geometry.pad + geometry.bar + 80],
  ]);
  const original = await sample(page, CAPTURE.dataUrl, [[120, 80]]);
  expect(seen.size).toEqual([geometry.width, geometry.height]);
  expect(seen.at[0][3]).toBe(0);                                    // nothing behind the window
  expect(seen.at[1]).toEqual([0xff, 0x5f, 0x57, 255]);              // the red light, at its centre
  expect(seen.at[2]).toEqual(original.at[0]);                       // the capture, under the bar
});

test('framed, even an untouched capture is drawn anew rather than copied as it came', async ({ page }) => {
  await installBridge(page);
  await page.goto('/');
  await page.locator('.capture').waitFor();
  await clear(page);
  await page.keyboard.press('Meta+c');
  await waitFor(page, 'copy_capture');                              // unframed: its own bytes

  await frameButton(page).click();
  await page.keyboard.press('Escape');
  await copied(page);
  expect((await sent(page)).map(call => call.cmd)).not.toContain('copy_capture');
});

test('a screenshot opens unframed, the frame as it was left a click away, and framing one leaves recordings as they were', async ({ page }) => {
  // The last recording was framed: a screenshot isn't, for that.
  const kept = { on: true, background: 'dusk', padding: 0.2, radius: 0, shadow: 0, device: 'window', color: 'black', island: false };
  await installBridge(page, { returns: { get_settings: { shortcut: 'Super+Digit4', frame: kept } } });
  await page.goto('/');
  await page.locator('.capture').waitFor();
  await waitFor(page, 'get_settings');
  await expect(page.locator('.canvas')).not.toHaveClass(/framed/);
  await expect(page.locator('.frame-under')).toBeHidden();
  await expect(frameButton(page)).not.toHaveClass(/\bon\b/);

  // Frame frames it, in the style it was left in.
  await frameButton(page).click();
  await expect(page.locator('.canvas')).toHaveClass(/framed/);
  await expect(frameButton(page)).toHaveClass(/\bon\b/);
  await expect(background(page, 'Dusk')).toHaveAttribute('aria-checked', 'true');
  await expect(device(page, 'Window')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('input[data-frame="padding"]')).toHaveValue('0.2');

  await clear(page);
  await background(page, 'Peach').click();
  await saved(page, { ...kept, background: 'peach' });

  // A slider is shown as it moves and kept once it is let go -- not on every step.
  await clear(page);
  await slide(page, 'padding', 0.6, false);
  await expect(page.locator('.dimensions')).toHaveText(/framed/);
  expect((await sent(page)).map(call => call.cmd)).not.toContain('set_frame');
  await slide(page, 'padding', 0.6);
  await saved(page, { ...kept, background: 'peach', padding: 0.6 });

  // Off for this screenshot is off for this screenshot: the next recording is still framed.
  await clear(page);
  await frameSwitch(page).click();
  await expect(page.locator('.canvas')).not.toHaveClass(/framed/);
  expect((await waitFor(page, 'set_frame')).args).toEqual({ frame: { ...kept, background: 'peach', padding: 0.6 } });
});

test('a framed screenshot comes back from Recent framed, and the next one opens unframed', async ({ page }) => {
  await installBridge(page);
  await page.goto('/');
  await page.locator('.capture').waitFor();
  await frameButton(page).click();
  await expect(page.locator('.canvas')).toHaveClass(/framed/);
  await page.keyboard.press('Escape');                    // the panel
  await page.keyboard.press('Escape');                    // and the capture
  await expect(page.locator('.recent')).toHaveCount(1);
  await page.locator('.recent').click();
  await expect(page.locator('.canvas')).toHaveClass(/framed/);

  await setBridge(page, { capture: { ...CAPTURE } });
  await emit(page, 'capture-changed');
  await expect(page.locator('.canvas')).not.toHaveClass(/framed/);
  // Both kept: the framed one went back into Recent as the new one came in.
  await page.keyboard.press('Escape');
  await expect(page.locator('.recent')).toHaveCount(2);
});

test('a tall screenshot keeps a device of its own, the wide one\'s until one is chosen', async ({ page }) => {
  await installBridge(page, { capture: { ...CAPTURE, width: 160, height: 240 },
                              returns: { get_settings: { frame: { ...DEFAULT_FRAME, device: 'browser' } } } });
  await page.goto('/');
  await page.locator('.capture').waitFor();
  await waitFor(page, 'get_settings');
  await frameButton(page).click();
  await expect(device(page, 'Browser')).toHaveAttribute('aria-checked', 'true');
  await clear(page);
  await device(page, 'Phone').click();
  await expect(device(page, 'Phone')).toHaveAttribute('aria-checked', 'true');
  // The wide one's is left as it was.
  await saved(page, { device: 'browser', tallDevice: 'phone' });
});

test('the panel goes with Escape or a click elsewhere, and leaves the frame on', async ({ page }) => {
  await installBridge(page);
  await page.goto('/');
  await page.locator('.capture').waitFor();
  await frameButton(page).click();
  await expect(page.locator('.frame-panel')).toBeVisible();
  await clear(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('.frame-panel')).toBeHidden();
  await expect(frameButton(page)).toBeFocused();
  expect((await sent(page)).map(call => call.cmd)).not.toContain('dismiss_editor');   // Escape put away only the panel

  await frameButton(page).click();
  await expect(page.locator('.frame-panel')).toBeVisible();
  await page.locator('.dimensions').click();
  await expect(page.locator('.frame-panel')).toBeHidden();
  await expect(page.locator('.canvas')).toHaveClass(/framed/);
});

test('a phone goes round it: a black body on every side, its own rounded screen, and the capture whole inside', async ({ page }) => {
  await installBridge(page);
  await page.goto('/');
  await page.locator('.capture').waitFor();
  await frameButton(page).click();
  await background(page, 'White').click();
  await device(page, 'Phone').click();
  await expect(device(page, 'Phone')).toHaveAttribute('aria-checked', 'true');
  // The phone's corners are its own; its colour and island are offered.
  await expect(page.locator('input[data-frame="radius"]')).toBeDisabled();
  await expect(page.locator('.frame-panel .colours')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Dynamic Island' })).not.toBeChecked();
  await page.keyboard.press('Escape');

  const style: FrameStyle = { ...DEFAULT_FRAME, on: true, background: 'white', device: 'phone' };
  const geometry = frameGeometry(CAPTURE.width, CAPTURE.height, 1, style);
  const edge = geometry.pad + geometry.bezel;
  const seen = await sample(page, await copied(page), [
    [1, 1], [geometry.pad + Math.round(geometry.bezel * 0.75), edge + Math.round(CAPTURE.height / 2)], [edge + 120, edge + 80],
  ]);
  const original = await sample(page, CAPTURE.dataUrl, [[120, 80]]);
  expect(seen.size).toEqual([geometry.width, geometry.height]);
  expect(seen.at[0]).toEqual([255, 255, 255, 255]);                 // the background
  expect(seen.at[1].slice(0, 3).every(value => value < 40)).toBe(true);   // the bezel, near black
  expect(seen.at[2]).toEqual(original.at[0]);                       // the capture, untouched inside
  await expect(page.locator('.dimensions')).toHaveText(`${geometry.width} × ${geometry.height} px, framed`);
});

test('a phone comes in four colours and can have its island; a tablet and a browser are offered too', async ({ page }) => {
  await installBridge(page);
  await page.goto('/');
  await page.locator('.capture').waitFor();
  await frameButton(page).click();
  await expect(page.locator('.frame-panel .devices').getByRole('radio')).toHaveText(['None', 'Window', 'Browser', 'Phone', 'Tablet']);
  // Colour and island belong to a phone; a window has neither.
  await device(page, 'Window').click();
  await saved(page, { device: 'window' });
  await expect(page.locator('.frame-panel .colours')).toBeHidden();
  await expect(page.getByRole('checkbox', { name: 'Dynamic Island' })).toBeHidden();
  await device(page, 'Phone').click();
  await saved(page, { device: 'phone' });
  await page.locator('.frame-panel').getByRole('radio', { name: 'Deep Blue' }).click();
  await saved(page, { device: 'phone', color: 'blue' });
  await page.getByRole('checkbox', { name: 'Dynamic Island' }).check();
  await saved(page, { device: 'phone', island: true });
  // A tablet keeps its colour, and has no island.
  await device(page, 'Tablet').click();
  await expect(page.locator('.frame-panel .colours')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Dynamic Island' })).toBeHidden();
  // The island is drawn over the screen: black in the middle of its top.
  await device(page, 'Phone').click();
  await page.keyboard.press('Escape');
  const style: FrameStyle = { ...DEFAULT_FRAME, on: true, device: 'phone', color: 'blue', island: true };
  const geometry = frameGeometry(CAPTURE.width, CAPTURE.height, 1, style);
  const edge = geometry.pad + geometry.bezel;
  const top = Math.round(edge + Math.min(CAPTURE.width, CAPTURE.height) * (0.028 + 0.047));
  const seen = await sample(page, await copied(page), [[edge + CAPTURE.width / 2, top]]);
  expect(seen.at[0].slice(0, 3).every(value => value < 10)).toBe(true);
});
