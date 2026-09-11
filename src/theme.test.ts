import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/** The dark tokens are declared twice in style.css: once under the media
 *  query, for a system set to dark, and once under data-theme="dark", for an
 *  appearance chosen in Mark's Settings or by the web demo. Two copies can
 *  drift; this makes sure they have not. */
describe('the dark theme', () => {
  // Vitest hands CSS imports back empty, so the stylesheet is read from disk.
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  const declarations = (block: string) =>
    [...block.matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map(m => `${m[1]}: ${m[2].replace(/\/\*.*?\*\//g, '').trim()}`);

  it('is the same set of tokens whether the system or the app chose it', () => {
    const byMedia = css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n  \}\n\}/)![1];
    const byAttribute = css.match(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/)![1];
    expect(declarations(byMedia).length).toBeGreaterThan(15);
    expect(declarations(byAttribute)).toEqual(declarations(byMedia));
  });

  it('is Fritter\'s slate, cool throughout', () => {
    const byAttribute = css.match(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/)![1];
    const tokens = Object.fromEntries(declarations(byAttribute).map(d => d.split(': ') as [string, string]));
    expect(tokens['--ink']).toBe('#f3f3f3');
    expect(tokens['--muted']).toBe('#9ca3af');
    expect(tokens['--scrim'].startsWith('#1b212a')).toBe(true);
    expect(tokens['--base'].startsWith('#1b212a')).toBe(true);
  });
});
