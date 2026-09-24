/** Mark's site. The page is written in site.html; this fills in what the app
 *  itself knows -- its version, its shortcut, and the three arrow styles, drawn
 *  by the same function that draws every arrow in the editor. The mark itself
 *  is the artwork in brand/, shown as it is. */
import './page.css';
import pkg from '../../package.json';
import markIcon from '../mark-icon.png';
import { arrowPolygon, arrowStrokes, arrowStrokeWidth, polygonPath, strokePath, type Arrow, type ArrowStyle } from '../annotations';
import { DEFAULT_SHORTCUT, prettyShortcut } from '../shortcut';

const all = <T extends Element>(selector: string) => Array.from(document.querySelectorAll<T>(selector));

// The mark, from the same import the editor uses, so the page and the app show
// one file and the build gives it a path that is right from anywhere.
for (const img of all<HTMLImageElement>('img[data-mark]')) img.src = markIcon;
for (const rel of ['icon', 'apple-touch-icon']) {
  document.head.append(Object.assign(document.createElement('link'), { rel, href: markIcon }));
}

// ---- what the app knows -------------------------------------------------------
for (const el of all('[data-version]')) el.textContent = pkg.version;
for (const el of all('[data-shortcut]')) el.textContent = prettyShortcut(DEFAULT_SHORTCUT);
// Tauri names the disk image after the version; the site serves it beside itself.
const dmg = `Mark_${pkg.version}_universal.dmg`;
for (const link of all<HTMLAnchorElement>('[data-download]')) { link.href = `./${dmg}`; link.setAttribute('download', dmg); }

// The Mac gets the download line; anyone else is told what they are looking at.
const platform = `${(navigator as { userAgentData?: { platform: string } }).userAgentData?.platform ?? ''} ${navigator.platform}`;
document.documentElement.classList.toggle('elsewhere', !/Mac/i.test(platform));

// ---- the three arrows ---------------------------------------------------------------
/** Drawn live with the editor's own geometry rather than pictured, for the same
 *  reason the style picker in the app is: a picture could come to misrepresent. */
const STYLES: { style: ArrowStyle; name: string }[] = [
  { style: 'taper', name: 'Tapered' }, { style: 'straight', name: 'Solid' }, { style: 'line', name: 'Thin' },
];
for (const slot of all('[data-arrows]')) {
  slot.innerHTML = STYLES.map(({ style, name }, i) => {
    const arrow: Arrow = { kind: 'arrow', id: i, style, x1: 20, y1: 94, x2: 84, y2: 22, color: '', weight: 10 };
    const art = style === 'line'
      ? `<path d="${strokePath(arrowStrokes(arrow))}" fill="none" stroke="currentColor" stroke-width="${arrowStrokeWidth(arrow.weight)}" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<path d="${polygonPath(arrowPolygon(arrow))}" fill="currentColor"/>`;
    return `<figure><svg viewBox="0 0 104 110" aria-label="${name} arrow">${art}</svg><figcaption>${name}</figcaption></figure>`;
  }).join('');
}

// ---- glyphs: the app's own strokes ------------------------------------------------------
const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
const GLYPHS: Record<string, string> = {
  crop: `<path d="M6.6 2.8v10.6h10.6M2.8 6.6h10.6v10.6" ${STROKE}/>`,
  timed: `<circle cx="10" cy="11.4" r="5.4" ${STROKE}/><path d="M10 8.4v3l2.1 1.3M8.1 3.4h3.8M10 3.4v2.6" ${STROKE}/>`,
  private: `<rect x="3.2" y="4.5" width="13.6" height="9.6" rx="1.8" ${STROKE}/><path d="M7.6 16.6h4.8M10 8.2v2.6" ${STROKE}/>`,
};
for (const el of all<HTMLElement>('[data-glyph]')) {
  el.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${GLYPHS[el.dataset.glyph!] ?? ''}</svg>`;
}
