/** What every page of the site takes from the app itself rather than saying for it: its mark,
 *  its version, its shortcut and its download. The mark is the same import the editor uses, so
 *  the page and the app show one file and the build gives it a path that is right from anywhere. */
import pkg from '../../package.json';
import markIcon from './mark-small.webp';   // The app's icon, sized for the page: it's never shown above 36px.
import { DEFAULT_SHORTCUT, prettyShortcut } from '../shortcut';

export const one = <T extends Element = HTMLElement>(selector: string, within: ParentNode = document) => within.querySelector<T>(selector)!;
export const all = <T extends Element = HTMLElement>(selector: string, within: ParentNode = document) => Array.from(within.querySelectorAll<T>(selector));

export function showAppFacts(): void {
  for (const img of all<HTMLImageElement>('img[data-mark]')) img.src = markIcon;
  for (const el of all('[data-version]')) el.textContent = pkg.version;
  for (const el of all('[data-shortcut]')) el.textContent = prettyShortcut(DEFAULT_SHORTCUT);
  // Tauri names the disk image after the version; the site serves it beside itself.
  const dmg = `Mark_${pkg.version}_universal.dmg`;
  for (const link of all<HTMLAnchorElement>('[data-download]')) { link.href = `./${dmg}`; link.setAttribute('download', dmg); }
}

/** A setup line, copied as it reads. */
export function copyButtons(): void {
  for (const button of all<HTMLButtonElement>('.copy-command')) {
    button.addEventListener('click', async () => {
      const text = button.parentElement?.querySelector('code')?.textContent ?? '';
      try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; }
      catch { button.textContent = 'Select it to copy'; }
      window.setTimeout(() => { button.textContent = 'Copy'; }, 1800);
    });
  }
}
