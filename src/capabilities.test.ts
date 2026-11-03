import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Software Update fits its window to what it shows, which means reading the
 *  window's size and scale before setting it. Without leave to read, the fit
 *  failed silently and the window kept its first size -- cutting its own OK
 *  button in half -- which no browser test can see, since only the app
 *  enforces it. */
describe('windows that fit themselves', () => {
  it('update may read its size and scale as well as set its size', () => {
    const capability = JSON.parse(readFileSync('src-tauri/capabilities/update.json', 'utf8')) as { permissions: string[] };
    expect(capability.permissions).toEqual(expect.arrayContaining([
      'core:window:allow-inner-size', 'core:window:allow-scale-factor', 'core:window:allow-set-size',
    ]));
  });

  // Software Update opens hidden and shows itself once it fits. Without leave
  // to, it would sit unseen until Mark gave up waiting and showed it unfitted.
  it('update may centre, show and focus itself', () => {
    const capability = JSON.parse(readFileSync('src-tauri/capabilities/update.json', 'utf8')) as { permissions: string[] };
    expect(capability.permissions).toEqual(expect.arrayContaining([
      'core:window:allow-center', 'core:window:allow-show', 'core:window:allow-set-focus',
    ]));
  });
});

/** Settings are a view of the editor's, so the editor's window has to be let
 *  do everything they ask of Rust. A command left out fails only in the app,
 *  where it is refused -- never in a browser test. */
it('the editor may run every command its Settings use', () => {
  const editor = JSON.parse(readFileSync('src-tauri/capabilities/editor.json', 'utf8')) as { permissions: string[] };
  const page = readFileSync('src/settings.ts', 'utf8');
  const used = [...page.matchAll(/command(?:<[^>]*>)?\('([a-z_]+)'/g)].map(match => `allow-${match[1].replaceAll('_', '-')}`);
  expect(used.length).toBeGreaterThan(10);
  expect(editor.permissions).toEqual(expect.arrayContaining([...new Set(used), 'core:app:allow-version']));
});
