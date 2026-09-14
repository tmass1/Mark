/** Mark's site. The page is written in site.html; this fills in what the app
 *  itself knows -- its version, its shortcut, and its mark, drawn by the same
 *  function that draws every arrow in the editor -- and hosts the web demo. */
import './page.css';
import pkg from '../../package.json';
import { arrowPolygon, arrowStrokes, arrowStrokeWidth, polygonPath, strokePath, type Arrow, type ArrowStyle } from '../annotations';
import { DEFAULT_SHORTCUT, prettyShortcut } from '../shortcut';

const all = <T extends Element>(selector: string) => Array.from(document.querySelectorAll<T>(selector));

// ---- what the app knows -------------------------------------------------------
for (const el of all('[data-version]')) el.textContent = pkg.version;
for (const el of all('[data-shortcut]')) el.textContent = prettyShortcut(DEFAULT_SHORTCUT);
// Tauri names the disk image after the version; the site serves it beside itself.
const dmg = `Mark_${pkg.version}_universal.dmg`;
for (const link of all<HTMLAnchorElement>('[data-download]')) { link.href = `./${dmg}`; link.setAttribute('download', dmg); }

// The Mac gets the download line; anyone else is told what they are looking at.
const platform = `${(navigator as { userAgentData?: { platform: string } }).userAgentData?.platform ?? ''} ${navigator.platform}`;
document.documentElement.classList.toggle('elsewhere', !/Mac/i.test(platform));

// ---- the mark --------------------------------------------------------------------
/** The icon's arrow, from the geometry in src/annotations.ts, so the site cannot
 *  drift from the app. Small sizes are the arrow alone on the tile, as the icon is. */
const MARK_ARROW = polygonPath(arrowPolygon(
  { kind: 'arrow', id: 0, x1: 792, y1: 232, x2: 322, y2: 702, color: '', weight: 74 }));
const MARK_FRAME = 'M258 396V308a50 50 0 0 1 50-50h88M628 258h88a50 50 0 0 1 50 50v88'
  + 'M766 628v88a50 50 0 0 1-50 50h-88M396 766h-88a50 50 0 0 1-50-50v-88';
/** The frame is the idea at large sizes and clutter at small ones, so as in the
 *  app's own icon set it is drawn only when there is room for it. */
const markSvg = (id: string, framed = false) => `<svg viewBox="0 0 1024 1024" aria-hidden="true">
  <defs>
    <linearGradient id="${id}-ground" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#43454e"/><stop offset="1" stop-color="#1a1b1f"/></linearGradient>
    <linearGradient id="${id}-ink" x1="792" y1="232" x2="322" y2="702" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ff7a63"/><stop offset=".55" stop-color="#ff4638"/><stop offset="1" stop-color="#e8281d"/></linearGradient>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#${id}-ground)"/>
  <rect x="100" y="100" width="824" height="824" rx="186" fill="none" stroke="#ffffff29" stroke-width="10"/>
  ${framed ? `<path d="${MARK_FRAME}" fill="none" stroke="#ffffff" stroke-opacity=".38" stroke-width="52" stroke-linecap="round" stroke-linejoin="round"/>` : ''}
  <path d="${MARK_ARROW}" fill="url(#${id}-ink)"/>
</svg>`;
all('[data-mark]').forEach((slot, i) => { slot.innerHTML = markSvg(`mark${i}`, slot.classList.contains('large')); });
const favicon = document.createElement('link');
favicon.rel = 'icon'; favicon.type = 'image/svg+xml';
favicon.href = `data:image/svg+xml,${encodeURIComponent(markSvg('fav').replace(/\n\s*/g, ''))}`;
document.head.append(favicon);

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
