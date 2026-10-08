import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Settings and Software Update fit their windows to what they show, which
 *  means reading the window's size and scale before setting it. Without leave
 *  to read, the fit failed silently and both windows kept their first size --
 *  Software Update cutting its own OK button in half, Settings hiding a whole
 *  section -- which no browser test can see, since only the app enforces it. */
describe('windows that fit themselves', () => {
  for (const name of ['settings', 'update']) {
    it(`${name} may read its size and scale as well as set its size`, () => {
      const capability = JSON.parse(readFileSync(`src-tauri/capabilities/${name}.json`, 'utf8')) as { permissions: string[] };
      expect(capability.permissions).toEqual(expect.arrayContaining([
        'core:window:allow-inner-size', 'core:window:allow-scale-factor', 'core:window:allow-set-size',
      ]));
    });
  }
});
