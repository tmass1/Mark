import { test, expect } from '@playwright/test';
import pkg from '../package.json' with { type: 'json' };
import board from '../src/site/board.json' with { type: 'json' };

/** The site: what it says about the app has to be what the app says about
 *  itself, and the demo in its frame has to be the real demo. */

test.use({ viewport: { width: 1280, height: 900 } });

test('the site takes its version, shortcut and download from the app', async ({ page }) => {
  await page.goto('/site.html');
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Mock it up. Send it to your AI agent, co-worker, designer or friend.');
  await expect(page.locator('.hero [data-version]')).toHaveText(pkg.version);
  await expect(page.locator('.hero [data-shortcut]')).toHaveText('⌘4');
  const dmg = `Mark_${pkg.version}_universal.dmg`;
  for (const link of await page.locator('[data-download]').all()) {
    await expect(link).toHaveAttribute('href', `./${dmg}`);
    await expect(link).toHaveAttribute('download', dmg);
  }
  // The arrow styles are drawn by the editor's geometry, one path each.
  await expect(page.locator('#arrows svg path')).toHaveCount(4);
  expect(await page.locator('#arrows button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual(['Mark', 'Tapered', 'Solid', 'Thin']);
  // Every picture shown is a real file. (The hero's picture is a phone's, below.)
  for (const img of await page.locator('img').all()) {
    if (!await img.isVisible()) continue;
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate(el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
  }
});

test('the site shows each device Frame puts round a capture, the phone as tall as the rest', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  // Without the motion, which moves each at its own speed: at rest they stand on one line.
  await page.goto('/site.html?motion=off');
  await expect(page.getByRole('heading', { name: 'A phone prototype belongs in a phone.' })).toBeVisible();
  await expect(page.locator('.devices figcaption')).toHaveText(['Phone', 'Browser', 'Tablet', 'Window']);
  const feet = await page.locator('.devices figure').evaluateAll(figures => figures.map(figure => figure.getBoundingClientRect().bottom));
  for (const foot of feet) expect(Math.abs(foot - feet[0])).toBeLessThanOrEqual(1);
  // A picture filling its place shows only a little less of itself: its background, not its device.
  for (const img of await page.locator('.devices img').all()) {
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const { shown, own } = await img.evaluate(el => {
      const i = el as HTMLImageElement;
      return { shown: i.clientWidth / i.clientHeight, own: i.naturalWidth / i.naturalHeight };
    });
    expect(Math.abs(shown / own - 1)).toBeLessThan(0.06);
  }
});

test('the bar keeps its links on one line, then gives them up, with Download at its end', async ({ page }) => {
  await page.goto('/site.html?motion=off');
  // The bar eases to a new width, and its parts can't be compared while it does.
  const settled = () => page.locator('.bar .wrap').evaluate(bar => Promise.all(bar.getAnimations({ subtree: true }).map(move => move.finished.catch(() => {}))));
  for (const width of [1360, 847, 721]) {
    await page.setViewportSize({ width, height: 800 });
    await settled();
    for (const link of await page.locator('.links a:visible').all()) expect((await link.boundingBox())!.height).toBeLessThan(44);
    const [bar, links, download] = [await page.locator('.bar .wrap').boundingBox(), await page.locator('.links').boundingBox(), await page.locator('.bar .get').boundingBox()];
    expect(links!.x + links!.width).toBeLessThanOrEqual(download!.x);
    expect(download!.x + download!.width).toBeLessThanOrEqual(bar!.x + bar!.width);
  }
  for (const width of [720, 400]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.locator('.links')).toBeHidden();
    await settled();
    const [bar, download] = [(await page.locator('.bar .wrap').boundingBox())!, (await page.locator('.bar .get').boundingBox())!];
    expect(bar.x + bar.width - (download.x + download.width)).toBeLessThanOrEqual(14);
  }
});

test('the headline names who a mock-up is for, one after another, unless motion is turned down', async ({ page }) => {
  await page.clock.install();
  await page.goto('/site.html');
  const heading = page.getByRole('heading', { level: 1 });
  const who = heading.locator('.who');
  await expect(heading).toHaveText(/^Mock it up\.\s*Send it to\s+your AI agent\.$/);
  await page.clock.runFor(2800);
  await expect(who).toHaveText('Co-worker');
  await expect(who).toHaveAttribute('data-who', 'coworker');
  await page.clock.runFor(2400 * 3);
  await expect(who).toHaveText('AI agent');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.clock.runFor(2400 * 3);
  await expect(who).toHaveText('AI agent');
});

test('a callout says the demo is live, and goes once the demo is used', async ({ page }) => {
  await page.goto('/site.html');
  // The demo is right there, so the hero has no button to go and find it.
  await expect(page.getByRole('link', { name: 'Try it in your browser' })).toHaveCount(0);
  const callout = page.locator('.try-me');
  await expect(callout).toBeVisible();
  await expect(callout).toHaveText('Try me — it’s the real app, live');
  // Above the demo, clear of the line above it.
  const above = (await callout.boundingBox())!, frame = (await page.locator('.demo-frame').boundingBox())!;
  const fine = (await page.locator('.hero .fine').boundingBox())!;
  expect(above.y + above.height).toBeLessThan(frame.y);
  expect(above.y).toBeGreaterThan(fine.y + fine.height);
  // Switching away from the page leaves it; using the demo takes it away.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(50);
  await expect(callout).not.toHaveClass(/used/);
  const demo = page.frameLocator('.demo');
  await expect(demo.frameLocator('.win.editor iframe').getByRole('heading', { name: 'Capture your screen' })).toBeVisible();
  await page.locator('.demo').click({ position: { x: 40, y: 200 } });
  await expect(callout).toHaveClass(/used/);
  await expect(callout).toHaveCSS('opacity', '0');
});

test('“Let an agent ask” has the demo play an agent asking, for the visitor to answer', async ({ page }) => {
  await page.goto('/site.html');
  const editor = page.frameLocator('.demo').frameLocator('.win.editor iframe');
  await expect(editor.getByRole('heading', { name: 'Capture your screen' })).toBeVisible();
  await page.getByRole('button', { name: 'Let an agent ask' }).click();
  await expect(editor.locator('.request-bar')).toContainText('Claude asks to see “the chart’s peak”');
  await expect(page.locator('.demo')).toBeInViewport();
  await expect(page.locator('.try-me')).toHaveClass(/used/);
});

test('⌘4 on the page reaches the demo while it is in view, as the demo says it will', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/site.html');
  const demo = page.locator('iframe.demo');
  const inside = demo.contentFrame();
  await inside.locator('.win.editor iframe').contentFrame().getByRole('heading', { name: 'Capture your screen' }).waitFor();
  await page.evaluate(() => document.documentElement.scrollTo({ top: 0, behavior: 'instant' }));
  // Out of view, the key is the browser's.
  await page.keyboard.press('Meta+4');
  await page.waitForTimeout(200);
  await expect(inside.locator('iframe.overlay')).toHaveCount(0);
  await demo.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.keyboard.press('Meta+4');
  await expect(inside.locator('iframe.overlay')).toHaveCount(1);
});

test('“Record a video” opens the demo’s Record bar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/site.html');
  await page.locator('[data-record]').click();
  const inside = page.locator('iframe.demo').contentFrame();
  await expect(inside.locator('iframe.overlay').contentFrame().locator('.choices')).toBeVisible();
  await expect(page.locator('iframe.demo')).toBeInViewport();
});

test('the setup line copies as it reads', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { (window as any).__copied = text; } } });
  });
  await page.goto('/site.html');
  const command = page.locator('.command code');
  await page.locator('.copy-command').click();
  await expect(page.locator('.copy-command')).toHaveText('Copied');
  expect(await page.evaluate(() => (window as any).__copied)).toBe(await command.textContent());
  expect(await command.textContent()).toBe("claude mcp add --scope user mark -- '/Applications/Mark.app/Contents/MacOS/mark' --mcp");
});

test('the guide to AI tools: reached from the home page, a section for every tool, each line copied as it reads', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { (window as any).__copied = text; } } });
  });
  await page.goto('/site.html');
  await expect(page.getByRole('navigation', { name: 'Site' }).getByRole('link', { name: 'Setup guide' })).toHaveAttribute('href', './ai.html');
  await page.getByRole('link', { name: 'the setup guide' }).click();
  await expect(page).toHaveURL(/\/ai\.html$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Use Mark with your AI tools');
  await expect(page.locator('footer [data-version]')).toHaveText(pkg.version);
  // The index names every tool, and each name leads to its section.
  const index = page.getByRole('navigation', { name: 'Tools' }).getByRole('link');
  await expect(index).toHaveText(['Claude Code', 'Codex', 'GitHub Copilot CLI', 'Grok Build', 'Claude Desktop', 'ChatGPT', 'Cursor', 'VS Code']);
  for (const link of await index.all()) {
    const id = (await link.getAttribute('href'))!.slice(1);
    await expect(page.locator(`article.tool#${id}`)).toHaveCount(1);
  }
  // A copied line is exactly the line shown, the block of settings included.
  for (const id of ['claude-code', 'claude-desktop', 'chatgpt-codex']) {
    const well = page.locator(`#${id} .command`).first();
    await well.getByRole('button', { name: 'Copy' }).click();
    expect(await page.evaluate(() => (window as any).__copied)).toBe(await well.locator('code').textContent());
  }
  expect(JSON.parse(await page.locator('#claude-desktop code').first().textContent() ?? '')).toEqual(
    { mcpServers: { mark: { command: '/Applications/Mark.app/Contents/MacOS/mark', args: ['--mcp'] } } });
  await expect(page.getByRole('link', { name: 'Add to Cursor' })).toHaveAttribute('href', /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=mark&config=/);
  await expect(page.getByRole('link', { name: 'Add to VS Code' })).toHaveAttribute('href', /^vscode:mcp\/install\?%7B/);
});

test('the guide reads on a phone, nothing wider than the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/ai.html');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('the hero is the real demo, framed without its caption', async ({ page }) => {
  await page.goto('/site.html');
  // Where the picture of the app used to be, under the heading and the buttons.
  await expect(page.locator('.hero .demo')).toHaveCount(1);
  await expect(page.locator('.demo')).toHaveCount(1);
  await expect(page.locator('.hero .hero-shot')).toBeHidden();
  const demo = page.frameLocator('.demo');
  await expect(demo.locator('html')).toHaveClass(/embedded/);
  await expect(demo.locator('.caption')).toBeHidden();
  const editor = demo.frameLocator('.win.editor iframe');
  await expect(editor.getByRole('heading', { name: 'Capture your screen' })).toBeVisible();
  await expect(editor.locator('.start kbd')).toHaveText('⌘4');
});

test('the bar’s links reach their sections', async ({ page }) => {
  await page.goto('/site.html');
  await page.locator('#features').scrollIntoViewIfNeeded();
  await page.getByRole('navigation', { name: 'Site' }).getByRole('link', { name: 'Video' }).click();
  await expect(page).toHaveURL(/#video$/);
  await expect(page.getByRole('heading', { name: 'When a still won’t show it, record it.' })).toBeInViewport();
});

test('a phone gets the picture of the app, and never loads the demo', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', request => asked.push(new URL(request.url()).pathname));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/site.html', { waitUntil: 'networkidle' });
  const picture = page.locator('.hero .hero-shot img');
  await expect(picture).toBeVisible();
  await picture.scrollIntoViewIfNeeded();
  await expect.poll(() => picture.evaluate(el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
  await expect(page.locator('.demo-frame')).toBeHidden();
  await expect(page.locator('.try-me')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Let an agent ask' })).toBeHidden();
  await expect(page.getByText('The demo wants a pointer and a keyboard.')).toBeVisible();
  expect(asked.filter(path => path.endsWith('demo.html'))).toEqual([]);
});

test('every page finds everything it asks for', async ({ page }) => {
  // The editor is loaded at the root and again from demo/, so a path that is
  // right from one is not automatically right from the other. This is the check
  // that caught the icon missing from the site and broken in the demo's frame.
  for (const at of ['/', '/demo.html', '/site.html', '/ai.html', '/privacy.html', '/terms.html']) {
    const missing: string[] = [];
    page.on('response', response => {
      // Only what was fetched over the wire: a data: or blob: URL has no status
      // worth reading, and the demo makes both.
      const url = new URL(response.url());
      if (url.protocol.startsWith('http') && response.status() >= 400) missing.push(url.pathname);
    });
    await page.goto(at, { waitUntil: 'networkidle' });
    expect(missing, at).toEqual([]);
    const broken = await page.evaluate(() =>
      // One that has been asked for and did not arrive. An img with no src yet
      // is waiting for one -- the demo's clipboard card holds one of those.
      [...document.images]
        .filter(img => img.getAttribute('src') && img.complete && !img.naturalWidth)
        .map(img => img.src));
    expect(broken, at).toEqual([]);
    page.removeAllListeners('response');
  }
});

test('the demo’s editor shows the icon on its empty state, from its own depth', async ({ page }) => {
  await page.goto('/demo.html');
  const editor = page.frameLocator('.win.editor iframe');
  await expect(editor.getByRole('heading', { name: 'Capture your screen' })).toBeVisible();
  expect(await editor.locator('.viewfinder').evaluate(
    el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
});

test('the bar turns into a floating capsule once the page scrolls', async ({ page }) => {
  await page.goto('/site.html');
  await expect(page.locator('.bar')).not.toHaveClass(/stuck/);
  await page.evaluate(() => window.scrollTo({ top: 400, behavior: 'instant' }));
  await expect(page.locator('.bar')).toHaveClass(/stuck/);
  await expect.poll(async () => (await page.locator('.bar .wrap').boundingBox())!.y).toBeGreaterThan(0);
});

test('Mark’s own arrow is drawn at the download button, and the page stands without the motion', async ({ page }) => {
  await page.goto('/site.html');
  await expect(page.locator('html')).toHaveClass(/ready/);
  await expect(page.locator('.hero-arrow path').first()).toBeAttached();
  // A heading rises a word at a time, and still reads as it's written.
  await expect(page.getByRole('heading', { name: 'Point at it. Don’t describe it.' }).locator('.w')).toHaveCount(6);

  await page.goto('/site.html?motion=off');
  await expect(page.locator('html')).not.toHaveClass(/motion/);
  await expect(page.locator('main .w')).toHaveCount(0);
  await expect(page.locator('.hero-arrow path').first()).toBeAttached();
  for (const heading of await page.locator('main h2').all()) await expect(heading).toHaveCSS('opacity', '1');
  await expect(page.locator('.how-track')).not.toHaveCSS('position', 'sticky');
});

test('scrolling steps through each way to capture, and past the paragraph the marks replace', async ({ page }) => {
  await page.goto('/site.html');
  await expect(page.locator('html')).toHaveClass(/pin-capture/);
  const through = async (selector: string, share: number) => page.evaluate(([selector, share]) => {
    const track = document.querySelector<HTMLElement>(selector as string)!, top = track.getBoundingClientRect().top + scrollY - 84;
    scrollTo({ top: top + (track.offsetHeight - (innerHeight - 84)) * (share as number), behavior: 'instant' });
  }, [selector, share] as const);
  await through('.capture-track', .1);
  await expect(page.locator('#grab')).toHaveAttribute('data-mode', 'region');
  await through('.capture-track', .5);
  await expect(page.locator('#grab')).toHaveAttribute('data-mode', 'display');
  await through('.capture-track', .9);
  await expect(page.locator('#grab')).toHaveAttribute('data-mode', 'record');

  await through('.how-track', 0);
  await expect(page.locator('#typed-count')).toHaveText('48 words');
  await expect(page.locator('#marks-count')).toHaveText('0 marks');
  await through('.how-track', .78);
  await expect(page.locator('#typed-count')).toHaveText('0 words');
  await expect(page.locator('#marks-count')).toHaveText('3 marks');
  await expect(page.locator('.how-marks .note, .how-marks g').first()).toBeAttached();
});

test('the marks on Step 2 are the editor’s own: drawing one adds a note', async ({ page }) => {
  await page.goto('/site.html');
  const picture = page.locator('#overlay');
  await picture.scrollIntoViewIfNeeded();
  await expect(page.locator('#steps textarea')).toHaveCount(3, { timeout: 10_000 });
  await expect(page.locator('#steps textarea').nth(2)).toHaveValue('Export only what’s filtered', { timeout: 10_000 });
  const box = (await picture.boundingBox())!;
  await page.mouse.move(box.x + box.width * .2, box.y + box.height * .7);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .4, box.y + box.height * .8, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('#steps textarea')).toHaveCount(4);
  await expect(page.locator('#steps textarea').nth(3)).toBeFocused();
});

test('the video section’s recording plays in view, and stops when clicked', async ({ page }) => {
  await page.goto('/site.html');
  const player = page.locator('#player'), movie = player.locator('video');
  await player.scrollIntoViewIfNeeded();
  await expect(player).toHaveClass(/playing/);
  const now = () => movie.evaluate(el => (el as HTMLVideoElement).currentTime);
  const from = await now();
  await expect.poll(now, { timeout: 8000 }).not.toBe(from);
  await player.click();
  await expect(player).not.toHaveClass(/playing/);
});

test('the recording can jump on a host that only sends whole files', async ({ page }) => {
  // The real host sends a whole file whatever part is asked for; the dev server doesn't, which hid this.
  // A browser that can't ask for part of a video can't jump in it, and Chrome then stays on the first frame.
  await page.route('**/site/board.{mp4,webm}', route => route.fulfill({ path: `public/site/${new URL(route.request().url()).pathname.split('/').pop()}` }));
  await page.goto('/site.html');
  const player = page.locator('#player'), movie = player.locator('video');
  await player.scrollIntoViewIfNeeded();
  const seen = () => movie.evaluate(el => {
    const video = el as HTMLVideoElement;
    return { reach: video.seekable.length ? video.seekable.end(0) : 0, at: video.currentTime };
  });
  await expect.poll(async () => (await seen()).reach, { timeout: 8000 }).toBeGreaterThan(14);
  await expect.poll(async () => (await seen()).at, { timeout: 8000 }).toBeGreaterThan(1);
  // It carries on past the part cut out, then comes back round to the start of what was kept, and plays on.
  const SECONDS = 14.2, afterCut = board.cut[1] * SECONDS;
  await expect.poll(async () => (await seen()).at, { timeout: 8000 }).toBeGreaterThan(afterCut + .2);
  await expect.poll(async () => (await seen()).at, { timeout: 8000 }).toBeLessThan(board.cut[0] * SECONDS);
  const back = (await seen()).at;
  await expect.poll(async () => (await seen()).at, { timeout: 8000 }).toBeGreaterThan(back + .2);
});

test('the changelog is the release notes’ own, newest first', async ({ page }) => {
  await page.goto('/site.html');
  await expect(page.locator('#changelog li')).toHaveCount(4);
  await expect(page.locator('#changelog li time').first()).toHaveText(pkg.version);
});

test('privacy, terms and contact are a click from the home page and the guide, and name no draft', async ({ page }) => {
  for (const start of ['/site.html', '/ai.html']) {
    await page.goto(start);
    const footer = page.locator('footer');
    await expect(footer.getByRole('link', { name: 'Contact' })).toHaveAttribute('href', 'mailto:hey@tommymassaro.com');
    await footer.getByRole('link', { name: 'Privacy' }).click();
    await expect(page).toHaveURL(/\/privacy\.html$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy');
    await page.goto(start);
    await footer.getByRole('link', { name: 'Terms' }).click();
    await expect(page).toHaveURL(/\/terms\.html$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Terms/);
    expect(await page.content()).not.toMatch(/\bdraft\b/i);
  }
});

test('the landing page fits a phone, nothing wider than the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/site.html');
  await expect(page.locator('html')).toHaveClass(/ready/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.locator('.hero-arrow path')).toHaveCount(0);
});

test('nothing to read or press runs off the side of a phone', async ({ page }) => {
  // The page can't scroll sideways, so what's too wide doesn't widen it: it's just cut off. Only pictures may be.
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/site.html?motion=off');
    const cutOff = await page.evaluate(() => [...document.querySelectorAll('main p, main h1, main h2, main h3, main li, main figcaption, main button, main a, footer a')]
      .filter(el => { const box = el.getBoundingClientRect(); return !el.closest('.player') && box.width > 0 && (box.right > innerWidth + 1 || box.left < -1); })
      .map(el => (el.textContent ?? '').trim().slice(0, 40)));
    expect(cutOff).toEqual([]);
  }
});

test('the capture picture asks for its width, or Safari’s grid sizes it to nothing', async ({ page }) => {
  // Only Safari shows this, and these tests run in Chromium, so what's checked is that it's asked for.
  for (const width of [390, 900, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/site.html?motion=off');
    const grab = page.locator('#grab');
    expect(await grab.evaluate(el => getComputedStyle(el).justifySelf)).toBe('stretch');
    expect((await grab.boundingBox())!.width).toBeGreaterThan(300);
  }
});

test.describe('on a phone', () => {
  // A phone as it says it is: touch, a narrow screen, and its own name for itself.
  test.use({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });

  test('its button sends the page to a Mac, and nothing is downloaded or counted', async ({ page }) => {
    await page.addInitScript(() => { navigator.share = async data => { (window as unknown as { shared: unknown }).shared = data; }; });
    const asked: string[] = [];
    page.on('request', request => asked.push(new URL(request.url()).pathname));
    await page.goto('/site.html');
    await expect(page.locator('html')).toHaveClass(/handheld/);
    const button = page.locator('.hero .get');
    await expect(button).toHaveText('Send to my Mac', { useInnerText: true });
    await expect(page.locator('.bar .get')).toHaveText('Send to Mac', { useInnerText: true });
    await expect(page.locator('.hero .fine')).toHaveText('Mark is a free Mac app. Send yourself the link, then download it on your Mac.', { useInnerText: true });
    for (const link of await page.locator('[data-download]').all()) {
      await expect(link).not.toHaveAttribute('download');
      await expect(link).not.toHaveAttribute('data-track-download');
    }
    await button.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { shared?: { url: string } }).shared?.url)).toBe(`${new URL(page.url()).origin}/`);
    expect(asked.filter(path => path.endsWith('.dmg'))).toEqual([]);
  });

  test('with no share sheet, its button copies the link', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { value: undefined });
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text; } } });
    });
    await page.goto('/site.html');
    const button = page.locator('.hero .get');
    await button.click();
    await expect(button).toHaveText('Link copied', { useInnerText: true });
    expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(`${new URL(page.url()).origin}/`);
    await expect(button).toHaveText('Send to my Mac', { useInnerText: true, timeout: 4000 });
  });

  test('the hero’s words stay as the scroll starts', async ({ page }) => {
    await page.goto('/site.html');
    await expect(page.locator('html')).toHaveClass(/ready/);
    await page.evaluate(() => scrollTo({ top: 30, behavior: 'instant' }));
    await page.waitForTimeout(700);
    expect(Number(await page.locator('.hero h1').evaluate(el => getComputedStyle(el).opacity))).toBeGreaterThan(.9);
  });

  test('a swipe up the capture picture scrolls the page, and leaves no selection behind', async ({ page }) => {
    // Without the selection the picture plays for itself on arrival, which would hide what the swipe left.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/site.html?motion=off');
    const grab = page.locator('#grab');
    await grab.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const reading = page.locator('#grab .reading'), size = await reading.textContent();
    expect(size).toMatch(/^\d+ × \d+ px$/);
    const box = (await grab.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2, before = await page.evaluate(() => scrollY);
    const touch = await page.context().newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 8; i++) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * 14 }] });
      await page.waitForTimeout(16);
    }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(before + 40);
    await expect(reading).toHaveText(size!);
  });

  test('drawing keeps its picture in view, with the keyboard down and no zoom', async ({ page }) => {
    await page.goto('/site.html?motion=off');
    const picture = page.locator('#overlay');
    await picture.scrollIntoViewIfNeeded();
    await expect(page.locator('#steps textarea')).toHaveCount(3, { timeout: 10_000 });
    // The tools that matter, in one row a thumb can hit; typing on a picture this small is left out.
    await expect(page.locator('#arrows')).toBeHidden();
    await expect(page.locator('#looks')).toBeHidden();
    await expect(page.locator('[data-tool="text"]')).toBeHidden();
    const tools = (await page.locator('#tools').boundingBox())!, clear = (await page.locator('#wipe').boundingBox())!;
    expect(Math.abs(tools.y + tools.height / 2 - (clear.y + clear.height / 2))).toBeLessThan(2);
    expect(tools.height).toBeGreaterThanOrEqual(44);
    const box = (await picture.boundingBox())!;
    await page.mouse.move(box.x + box.width * .2, box.y + box.height * .7);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .4, box.y + box.height * .8, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('#steps textarea')).toHaveCount(4);
    await expect(page.locator('#steps textarea').nth(3)).not.toBeFocused();
    // iOS zooms the page in on any field set smaller than this.
    expect(await page.locator('#steps textarea').first().evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
  });

  test('the drawing tools keep to one row, down to the smallest phone', async ({ page }) => {
    for (const width of [320, 360, 390, 430]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/site.html?motion=off');
      const middle = (box: { y: number; height: number }) => box.y + box.height / 2;
      const tools = (await page.locator('#tools').boundingBox())!, undo = (await page.locator('#undo').boundingBox())!, clear = (await page.locator('#wipe').boundingBox())!;
      expect(Math.abs(middle(tools) - middle(clear))).toBeLessThan(2);
      expect(Math.abs(middle(undo) - middle(clear))).toBeLessThan(2);
      expect(clear.x + clear.width).toBeLessThanOrEqual(width);
      expect((await page.locator('[data-tool="box"]').boundingBox())!.width).toBeGreaterThanOrEqual(30);
    }
  });

  test('a finger on the drawing picture stays there, in Safari too', async ({ page }) => {
    // Safari ignores touch-action on the svg layer itself and scrolls away mid-arrow, so it has to be on the box
    // around it. Only Safari shows this, and these tests run in Chromium, so what's checked is that it's asked for.
    await page.goto('/site.html?motion=off');
    expect(await page.locator('#picture').evaluate(el => getComputedStyle(el).touchAction)).toBe('none');
  });

  test('every note stays in view, and the panel doesn’t mention a keyboard', async ({ page }) => {
    await page.goto('/site.html?motion=off');
    const picture = page.locator('#overlay'), notes = page.locator('#steps textarea');
    await picture.scrollIntoViewIfNeeded();
    await expect(notes).toHaveCount(3, { timeout: 10_000 });
    const box = (await picture.boundingBox())!;
    for (const [from, to] of [[.08, .2], [.38, .5], [.66, .78]]) {
      await page.mouse.move(box.x + box.width * from, box.y + box.height * .78);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * to, box.y + box.height * .9, { steps: 6 });
      await page.mouse.up();
    }
    await expect(notes).toHaveCount(6);
    // A scrolling box inside the scrolling page would put the newest note out of sight.
    expect(await page.locator('#steps').evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    await expect(page.locator('.steps-end')).toHaveText('Type a note and it goes on the picture.', { useInnerText: true });
  });

  test('a recording that isn’t allowed to play by itself offers a Play button', async ({ page }) => {
    // As an iPhone in Low Power Mode does: only a tap can start a video.
    await page.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        return (window as unknown as { tapped?: boolean }).tapped ? play.call(this) : Promise.reject(new DOMException('Needs a tap', 'NotAllowedError'));
      };
    });
    await page.goto('/site.html');
    const player = page.locator('#player');
    await player.scrollIntoViewIfNeeded();
    await expect(page.locator('.player-play')).toHaveAttribute('aria-label', 'Play');
    await expect(player).not.toHaveClass(/playing/);
    await page.evaluate(() => { (window as unknown as { tapped: boolean }).tapped = true; });
    await player.click();
    await expect(player).toHaveClass(/playing/);
    await expect.poll(() => page.locator('#player video').evaluate(el => !(el as HTMLVideoElement).paused)).toBe(true);
  });

  test('its pictures are sized for it', async ({ page }) => {
    await page.goto('/site.html?motion=off');
    const scene = page.locator('#grab img');
    await scene.scrollIntoViewIfNeeded();
    await expect.poll(() => scene.evaluate(el => (el as HTMLImageElement).currentSrc)).toContain('scene-1200.webp');
    expect(await page.locator('.bar .brand img').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeLessThanOrEqual(144);
  });
});

test.describe('on a tablet', () => {
  test.use({
    viewport: { width: 1024, height: 768 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  });

  test('an iPad, which says it’s a Mac, gets the picture and no download', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
    });
    const asked: string[] = [];
    page.on('request', request => asked.push(new URL(request.url()).pathname));
    await page.goto('/site.html', { waitUntil: 'networkidle' });
    await expect(page.locator('.hero .get')).toHaveText('Send to my Mac', { useInnerText: true });
    await expect(page.locator('.hero .hero-shot')).toBeVisible();
    await expect(page.locator('.demo-frame')).toBeHidden();
    await expect(page.getByText('The demo wants a pointer and a keyboard.')).toBeVisible();
    expect(asked.filter(path => path.endsWith('demo.html'))).toEqual([]);
  });
});
