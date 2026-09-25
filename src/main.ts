import './style.css';
import { command, isTauri, watchCapture, watchSettings, type CapturePreview, type Snapshot } from './platform';
import { DEFAULT_SHORTCUT, prettyShortcut } from './shortcut';
// The icon as an import, so its path is right whether this page is the app's
// own or the copy the web demo runs in a frame.
import markIcon from './mark-icon.png';
import { copyThenDismiss } from './model';
import { sampleCapture } from './sample';
import { ARROW_STYLES, AnnotationLayer, COLORS, LOOKS, NOTE_MODES, SHAPE_FILLS, arrowPolygon, arrowStrokes, arrowStrokeWidth,
         FONT, arrowPaint, badgeAt, describe, drawAnnotations, fillOf, fillable, hasLook, inkOn, isShape, numbered,
         outsetOps, pathData, polygonPath, stepArrow, stepList, strokePath, styleOf, takesLooks, textSize,
         type Annotation, type ArrowStyle, type Look, type NoteMode, type Point, type ShapeFill, type Tool } from './annotations';

/** Each style's button previews itself, drawn from the geometry it will draw
 *  with, so a picker cannot come to misrepresent what it picks. */
const STYLE_NAMES: Record<ArrowStyle, string> = { taper: 'Tapered', straight: 'Solid', line: 'Thin' };
function stylePreview(style: ArrowStyle): string {
  const sample = { kind: 'arrow', id: 0, x1: 3, y1: 16, x2: 17, y2: 4, color: '', weight: 2.6, style } as const;
  return style === 'line'
    ? `<path d="${strokePath(arrowStrokes(sample))}" fill="none" stroke="currentColor"
         stroke-width="${arrowStrokeWidth(sample.weight)}" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="${polygonPath(arrowPolygon(sample))}" fill="currentColor"/>`;
}

/** Each fill button carries both a box and an ellipse; CSS shows whichever
 *  shape is in hand, so the picker reads as "this box, solid" and not an
 *  abstract toggle. Solid matches the outline's outer edge, as in the editor. */
const FILL_NAMES: Record<ShapeFill, string> = { outline: 'Outline', solid: 'Solid' };
function fillPreview(fill: ShapeFill): string {
  return fill === 'solid'
    ? `<rect class="as-box" x="2.5" y="4.5" width="15" height="11" rx="2" fill="currentColor"/>
       <ellipse class="as-ellipse" cx="10" cy="10" rx="7.5" ry="5.5" fill="currentColor"/>`
    : `<rect class="as-box" x="3.5" y="5.5" width="13" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/>
       <ellipse class="as-ellipse" cx="10" cy="10" rx="6.5" ry="4.5" fill="none" stroke="currentColor" stroke-width="2"/>`;
}


/** The looks are drawn from the geometry they draw with, too: a sample arrow,
 *  its border pushed out by the same function the image uses, and its shadow
 *  as the same shape dropped below it. In the toolbar's own ink, though, and
 *  the drop exaggerated -- a white border on a light bar, or a shadow a third
 *  of a pixel deep, would be no picture at all. */
const LOOK_NAMES: Record<Look, string> = { shadow: 'Shadow', border: 'Border' };
function lookPreview(looks: readonly Look[]): string {
  const sample = { kind: 'arrow', id: 0, x1: 4.4, y1: 14.6, x2: 15, y2: 4.6, color: '', weight: 2.2, style: 'taper' } as const;
  const polygon = arrowPolygon(sample);
  const shadow = looks.includes('shadow')
    ? `<path d="${polygonPath(polygon.map(([x, y]) => [x + 0.5, y + 1.9] as Point))}" fill="currentColor" opacity=".3"/>` : '';
  const border = looks.includes('border')
    ? `<path d="${pathData(outsetOps(polygon, 1.5))}" fill="none" stroke="currentColor" stroke-width="1"/>` : '';
  return shadow + border + `<path d="${polygonPath(polygon)}" fill="currentColor"/>`;
}

/** How the notes go on the image, named as the three ways they look. */
const NOTE_NAMES: Record<NoteMode, string> = { off: 'Off', beside: 'Beside', framed: 'Framed' };

/** The pointer for a tool that has something to say about what it will draw: a
 *  crosshair, because the mark lands exactly where you press, with a small copy
 *  of that mark beside it. The arrow is drawn from the same geometry the picker
 *  and the editor use, and the badge takes its ink from the same rule the badge
 *  itself does, so the pointer cannot come to misrepresent what it draws. The
 *  colour is the one in hand, and the badge's number is the one about to be
 *  used -- both questions the toolbar cannot answer while you are looking at
 *  the image.
 *
 *  Everything gets a white understroke: a cursor passes over whatever the
 *  screenshot happens to be, and a white arrow on white would otherwise be no
 *  arrow at all. */
function toolCursor(tool: Tool, numbering: boolean, style: ArrowStyle, color: string, next: number): string {
  let glyph: (halo: boolean) => string;
  if (tool === 'arrow' && !numbering) {
    const sample = { kind: 'arrow', id: 0, x1: 16, y1: 30, x2: 29.5, y2: 16.5, color: '', weight: 3.6, style } as const;
    glyph = style === 'line'
      ? halo => `<path d="${strokePath(arrowStrokes(sample))}" fill="none"
          stroke="${halo ? '#fff' : color}" stroke-width="${arrowStrokeWidth(sample.weight) + (halo ? 2.2 : 0)}"
          stroke-linecap="round" stroke-linejoin="round"/>`
      : halo => `<path d="${polygonPath(arrowPolygon(sample))}" fill="${halo ? '#fff' : color}"
          ${halo ? 'stroke="#fff" stroke-width="2.2" stroke-linejoin="round"' : ''}/>`;
  } else if (tool === 'arrow') {
    // The badge with its arrow leaving it, which is what a drag makes: the
    // number and the arrow style are both what the pointer is being asked
    // about. Built from stepArrow, so the tail clears the disc here for the
    // same reason it does on the image.
    const badge = { kind: 'step', id: 0, x: 12.5, y: 25.5, to: [31, 13] as Point,
                    color: '', weight: 5, style } as const;
    const shaft = stepArrow(badge);
    const paint = shaft && arrowPaint(shaft);
    const arrow = (halo: boolean) => !paint ? ''
      : paint.stroked
        ? `<path d="${strokePath(paint.runs)}" fill="none" stroke="${halo ? '#fff' : color}"
             stroke-width="${paint.width + (halo ? 2 : 0)}" stroke-linecap="round" stroke-linejoin="round"/>`
        : `<path d="${polygonPath(paint.polygon)}" fill="${halo ? '#fff' : color}"
             ${halo ? 'stroke="#fff" stroke-width="2" stroke-linejoin="round"' : ''}/>`;
    // Room for two digits before the numeral has to give any up.
    const size = next > 9 ? 8 : 10;
    glyph = halo => halo
      ? arrow(true) + `<circle cx="12.5" cy="25.5" r="7" fill="#fff" stroke="#fff" stroke-width="2.4"/>`
      : arrow(false) + `<circle cx="12.5" cy="25.5" r="7" fill="${color}"/>`
        + `<text x="12.5" y="25.5" fill="${inkOn(color)}" font-family="${FONT}" font-size="${size}"
             font-weight="700" text-anchor="middle" dominant-baseline="central">${next}</text>`;
  } else return '';
  const cross = 'M7 .9v12.2M.9 7h12.2';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">`
    + `<path d="${cross}" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" opacity=".92"/>`
    + glyph(true)
    + `<path d="${cross}" fill="none" stroke="#1c1c1e" stroke-width="1.4" stroke-linecap="round"/>`
    + glyph(false)
    + `</svg>`;
  // 7,7 is where the two lines cross, and where the mark will land.
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 7 7, crosshair`;
}

/** Captures kept after they leave the editor, newest first. Memory only: this
 *  is an undo for closing, not a library. */
interface Past { id: number; capture: CapturePreview; thumb: string; annotations: Annotation[] }
const KEPT = 6;
/** Roughly 90 MB of image once decoded from base64. */
const KEPT_CHARS = 120_000_000;

/** Six tools do not fit as words, so the palette is glyphs with real labels
 *  behind them for screen readers and tooltips. */
const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
/** The three ways into a capture. Part of the screen, all of it, and part of it
 *  later: a frame, a filled display, and a stopwatch, so the set reads as three
 *  answers to the same question rather than three unrelated pictures. */
const CAPTURE_MODES: { mode: string; name: string; hint: string; art: string }[] = [
  { mode: 'region', name: 'Region', hint: prettyShortcut(DEFAULT_SHORTCUT), art:
    `<path d="M4.4 7.7V5.9a1.5 1.5 0 0 1 1.5-1.5h1.8M12.3 4.4h1.8a1.5 1.5 0 0 1 1.5 1.5v1.8`
    + `M15.6 12.3v1.8a1.5 1.5 0 0 1-1.5 1.5h-1.8M7.7 15.6H5.9a1.5 1.5 0 0 1-1.5-1.5v-1.8" ${STROKE}/>` },
  { mode: 'display', name: 'Whole Screen', hint: '', art:
    `<rect x="3.2" y="4.5" width="13.6" height="9.6" rx="1.8" fill="currentColor" opacity=".16"/>`
    + `<rect x="3.2" y="4.5" width="13.6" height="9.6" rx="1.8" ${STROKE}/>`
    + `<path d="M7.6 16.6h4.8" ${STROKE}/>` },
  { mode: 'timed', name: 'Timed Region', hint: '5s', art:
    `<circle cx="10" cy="11.4" r="5.4" ${STROKE}/>`
    + `<path d="M10 8.4v3l2.1 1.3M8.1 3.4h3.8M10 3.4v2.6" ${STROKE}/>` },
];

/** A numbered mark's badge, small enough to sit in a 20-unit glyph. */
const BADGE = (cx: number, cy: number, r: number) =>
  `<mask id="badge-${cx}-${cy}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff"/>`
  + `<path d="M${cx - 1.1} ${cy - 1.2} ${cx + 0.3} ${cy - 2.3}v4.6M${cx - 0.9} ${cy + 2.3}h2.5" fill="none" stroke="#000"`
  + ` stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></mask>`
  + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" mask="url(#badge-${cx}-${cy})"/>`;

/** The rail is slots rather than tools: a slot holds one tool, or a few that are
 *  the same tool done differently, and shows whichever was last chosen from it.
 *  Numbering is one of those differences -- a switch in the toolbar was there to
 *  be missed, where a slot wears what it will draw. Photoshop's arrangement, and
 *  for the same reason. */
interface Choice { id: Tool; numbered?: boolean; name: string; art: string }
const SLOTS: Choice[][] = [
  [
    { id: 'arrow', name: 'Arrow', art: `<path d="M5.5 14.5 14 6M5.5 14.5h5.2M5.5 14.5V9.3" ${STROKE}/>` },
    { id: 'arrow', numbered: true, name: 'Numbered arrow', art:
      `<path d="M9.4 11.2 15 5.6M15 5.6h-3.6M15 5.6v3.6" ${STROKE}/>` + BADGE(6.4, 13.6, 4.3) },
  ],
  [{ id: 'line', name: 'Line', art: `<path d="M5.4 14.6 14.6 5.4" ${STROKE}/>` }],
  [{ id: 'pen', name: 'Pen', art:
    `<path d="M4.2 13.8c1.9-4.6 3.2 2.3 5.1-1.1s2.9 3 4.4-1.2 1.4 2 2.1.9" ${STROKE}/>` }],
  [{ id: 'text', name: 'Text', art: `<path d="M5 6h10M10 6v8.5M7.8 14.5h4.4" ${STROKE}/>` }],
  [
    { id: 'box', name: 'Box', art: `<rect x="4.6" y="5.8" width="10.8" height="8.4" rx="1.4" ${STROKE}/>` },
    { id: 'box', numbered: true, name: 'Numbered box', art:
      `<rect x="6.4" y="7.4" width="9" height="7.4" rx="1.4" ${STROKE}/>` + BADGE(5.6, 6.2, 4.1) },
  ],
  [
    { id: 'ellipse', name: 'Ellipse', art: `<ellipse cx="10" cy="10" rx="5.6" ry="4.4" ${STROKE}/>` },
    { id: 'ellipse', numbered: true, name: 'Numbered ellipse', art:
      `<ellipse cx="11" cy="11.2" rx="4.6" ry="3.7" ${STROKE}/>` + BADGE(5.6, 6.2, 4.1) },
  ],
  [{ id: 'highlight', name: 'Highlighter', art:
    `<path d="M4.6 15.6h10.8" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" opacity=".45"/>` +
    `<path d="M6.9 12.4 12.4 6.9l2 2-5.5 5.5z" ${STROKE}/>` }],
  [{ id: 'redact', name: 'Redact', art:
    `<path d="M4.8 5.2h4.1v4.1H4.8zM11.1 5.2h4.1v4.1h-4.1zM4.8 10.7h4.1v4.1H4.8zM11.1 10.7h4.1v4.1h-4.1z" fill="currentColor"/>` }],
  [{ id: 'crop', name: 'Crop', art:
    `<path d="M6.6 2.8v10.6h10.6M2.8 6.6h10.6v10.6" ${STROKE}/>` }],
];
/** Which variant each slot is wearing. */
const worn = SLOTS.map(() => 0);
const slotButton = (slot: Choice[], index: number) => {
  const choice = slot[worn[index]];
  // No tooltip on a slot with a menu: resting on it opens the menu, which names
  // every way it has including the one it is wearing.
  return `<button class="tool" type="button" role="radio" data-slot="${index}" aria-checked="${index === 0}"
        ${slot.length > 1 ? 'aria-haspopup="menu" aria-expanded="false"' : `title="${choice.name}"`}>`
    + `<svg viewBox="0 0 20 20" aria-hidden="true">${choice.art}</svg>`
    + (slot.length > 1 ? '<span class="tool-more" aria-hidden="true"></span>' : '')
    + `<span class="sr">${choice.name}</span></button>`;
};

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="titlebar" data-tauri-drag-region>
    <span class="app-title" data-tauri-drag-region>Mark</span>
    <span class="preview-label" hidden>Browser preview</span>
    <button class="settings-button subtle icon" type="button" title="Settings (⌘,)" aria-label="Settings" hidden>
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.1" ${STROKE}/><path d="M10 2.8v2.1M10 15.1v2.1M2.8 10h2.1M15.1 10h2.1M4.9 4.9l1.5 1.5M13.6 13.6l1.5 1.5M4.9 15.1l1.5-1.5M13.6 6.4l1.5-1.5" ${STROKE}/></svg>
    </button>
    <div class="capture-control">
      <button class="capture-go" type="button">Capture</button>
      <button class="capture-more" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Capture options">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.4 8.4 10 12l3.6-3.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="capture-menu" hidden>
        ${CAPTURE_MODES.map(item => `<button type="button" data-mode="${item.mode}">
          <svg viewBox="0 0 20 20" aria-hidden="true">${item.art}</svg>
          <span>${item.name}</span>${item.hint ? `<kbd>${item.hint}</kbd>` : ''}
        </button>`).join('')}
      </div>
    </div>
  </header>
  <div class="toolbar" role="toolbar" aria-label="Annotation tools" hidden>
    <div class="swatches" role="radiogroup" aria-label="Color">
      ${COLORS.map(color => `<button class="swatch" type="button" role="radio" aria-checked="false"
        data-color="${color.value}" style="--swatch:${color.value}" title="${color.name}"><span class="sr">${color.name}</span></button>`).join('')}
    </div>
    <div class="styles" role="radiogroup" aria-label="Arrow style" hidden>
      ${ARROW_STYLES.map(style => `<button class="style" type="button" role="radio" data-style="${style}"
        aria-checked="${style === 'taper'}" title="${STYLE_NAMES[style]} arrow"><svg viewBox="0 0 20 20"
        aria-hidden="true">${stylePreview(style)}</svg><span class="sr">${STYLE_NAMES[style]}</span></button>`).join('')}
    </div>
    <div class="looks" hidden>
      <button class="looks-button" type="button" aria-haspopup="menu" aria-expanded="false"
        aria-label="Shadow and border" title="Shadow and border"><svg viewBox="0 0 20 20"
        aria-hidden="true">${lookPreview(LOOKS)}</svg></button>
      <div class="looks-menu" role="menu" aria-label="Shadow and border" hidden>
        ${LOOKS.map(look => `<button type="button" role="menuitemcheckbox" aria-checked="false" data-look="${look}">
          <svg viewBox="0 0 20 20" aria-hidden="true">${lookPreview([look])}</svg><span>${LOOK_NAMES[look]}</span>
          <svg class="tick" viewBox="0 0 20 20" aria-hidden="true"><path d="M5.2 10.4 8.6 13.6 14.8 6.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>`).join('')}
      </div>
    </div>
    <div class="fills" role="radiogroup" aria-label="Shape fill" hidden>
      ${SHAPE_FILLS.map(fill => `<button class="style" type="button" role="radio" data-fill="${fill}"
        aria-checked="${fill === 'outline'}" title="${FILL_NAMES[fill]} shape"><svg viewBox="0 0 20 20"
        aria-hidden="true">${fillPreview(fill)}</svg><span class="sr">${FILL_NAMES[fill]}</span></button>`).join('')}
    </div>
    <label class="size"><span class="size-word">Size</span>
      <input class="weight" type="range" min="0.1" max="2.5" step="0.05" value="1" aria-label="Size" />
    </label>
    <span class="spacer"></span>
    <span class="chosen" hidden aria-live="polite"></span>
    <button class="back subtle icon" type="button" title="Send backward (⌘[)" aria-label="Send backward">
      <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.2" y="3.2" width="9" height="9" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 15.2a1.6 1.6 0 0 0 1.6 1.6h5.6a1.6 1.6 0 0 0 1.6-1.6V9.6A1.6 1.6 0 0 0 15.2 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </button>
    <button class="front subtle icon" type="button" title="Bring forward (⌘])" aria-label="Bring forward">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12 4.8a1.6 1.6 0 0 0-1.6-1.6H4.8A1.6 1.6 0 0 0 3.2 4.8v5.6A1.6 1.6 0 0 0 4.8 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><rect x="7.8" y="7.8" width="9" height="9" rx="1.6" fill="currentColor" opacity=".9"/></svg>
    </button>
    <button class="undo subtle icon" type="button" title="Undo (⌘Z)" aria-label="Undo">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.2 5.4 3.6 9l3.6 3.6M3.9 9h7.5a4.4 4.4 0 0 1 0 8.8h-1.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <button class="remove subtle icon" type="button" title="Delete selection (⌫)" aria-label="Delete selection">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.8 6.2h12.4M8.2 6.2V4.6a1 1 0 0 1 1-1h1.6a1 1 0 0 1 1 1v1.6M5.4 6.2l.7 9.4a1.4 1.4 0 0 0 1.4 1.3h5a1.4 1.4 0 0 0 1.4-1.3l.7-9.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </div>
  <div class="workspace">
    <nav class="rail" aria-label="Tools" hidden>
      <div class="tools" role="radiogroup" aria-label="Tool">
        <div class="tool-group">${SLOTS.slice(0, -1).map(slotButton).join('')}</div>
        <div class="tool-group">${SLOTS.slice(-1).map((slot, i) => slotButton(slot, SLOTS.length - 1 + i)).join('')}</div>
      </div>
      <div class="tool-menu" role="menu" hidden></div>
    </nav>
  <main class="canvas" aria-label="Screenshot editor">
    <div class="stage" hidden>
      <img class="capture" alt="Captured screenshot" draggable="false" />
      <svg class="overlay" xmlns="http://www.w3.org/2000/svg" role="group" aria-label="Arrow annotations"></svg>
    </div>
    <section class="empty" hidden>
      <!-- The icon itself, so what greets you on launch is exactly what sits in
           the Dock. It used to be redrawn from paths, which is how the two came
           to be different pictures. -->
      <img class="viewfinder" src="${markIcon}" alt="" width="72" height="72" />
      <h1>Capture a region</h1><p class="empty-hint">A little less between seeing and sharing.</p>
      <button class="start primary" type="button">Capture Region <kbd>${prettyShortcut(DEFAULT_SHORTCUT)}</kbd></button>
      <section class="recents" hidden aria-label="Recent captures">
        <p class="recents-label">Recent</p>
        <div class="recent-list"></div>
      </section>
      <p class="quit-hint" hidden>Mark lives in the menu bar · ⌘, settings · ⌘W hides it · ⌘Q quits</p>
    </section>
  </main>
  </div>
  <aside class="message" role="status" aria-live="polite" hidden><span></span><button class="settings" hidden>Open System Settings</button></aside>
  <aside class="steps" hidden aria-label="Steps">
    <header class="steps-head" title="Drag to move">
      <button class="steps-fold subtle icon" type="button" aria-expanded="true" title="Minimise">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.6 8.4 10 11.8l3.4-3.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <span class="steps-title">Steps</span>
      <span class="steps-tally"></span>
      <span class="push"></span>
      <button class="steps-close subtle icon" type="button" title="Close (the count in the footer brings it back)" aria-label="Close">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.8 5.8l8.4 8.4M14.2 5.8l-8.4 8.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
      </button>
    </header>
    <div class="steps-edge" data-edge="left" title="Drag to resize"></div>
    <div class="steps-edge" data-edge="right" title="Drag to resize"></div>
    <div class="step-rows"></div>
    <div class="steps-foot">
      <div class="steps-show" role="radiogroup" aria-label="Notes on the image"
        title="Off, the image carries only the numbers and the words are copied as text — which is the point, since words in a picture have to be read back out of it. Beside writes each note next to its number, as the Text tool would. Framed puts it in with the number, in one pill.">
        <span class="steps-show-label">On the image</span>
        <span class="segments">${NOTE_MODES.map(mode => `<button class="segment" type="button" role="radio"
          data-notes="${mode}" aria-checked="${mode === 'off'}">${NOTE_NAMES[mode]}</button>`).join('')}</span>
      </div>
      <button class="steps-copy glassy" type="button">Copy list <kbd>⌘⇧L</kbd></button>
    </div>
  </aside>
  <aside class="crop-bar" hidden>
    <span class="crop-size"></span>
    <button class="crop-cancel subtle" type="button">Cancel</button>
    <button class="crop-apply primary" type="button">Crop <kbd>⏎</kbd></button>
  </aside>
  <footer>
    <span class="dimensions" aria-label="Image dimensions"></span>
    <label class="zoom"><span class="sr">Zoom</span>
      <select class="zoom-select">
        <option value="fit">Fit</option>
        <option value="0.25">25%</option><option value="0.5">50%</option>
        <option value="1">100%</option><option value="2">200%</option><option value="4">400%</option>
      </select>
      <svg class="chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="M6.6 8.4 10 11.8l3.4-3.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </label>
    <span class="push"></span>
    <button class="choose glassy" type="button" hidden>Choose image…</button>
    <span class="exports">
    <button class="share glassy icon" type="button" title="Share (⌘⇧S)" aria-label="Share">
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.8v9M6.8 6l3.2-3.2L13.2 6"/><path d="M5 10.6H4.2a1.4 1.4 0 0 0-1.4 1.4v4.2a1.4 1.4 0 0 0 1.4 1.4h11.6a1.4 1.4 0 0 0 1.4-1.4V12a1.4 1.4 0 0 0-1.4-1.4H15"/></svg>
    </button>
    <button class="save glassy icon" type="button" title="Save to a file (⌘S)" aria-label="Save to a file">
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.8v9M6.8 8.6 10 11.8l3.2-3.2"/><path d="M3.4 14v2.2a1.4 1.4 0 0 0 1.4 1.4h10.4a1.4 1.4 0 0 0 1.4-1.4V14"/></svg>
    </button>
    </span>
    <button class="steps-toggle glassy" type="button" hidden aria-expanded="false"
      title="What each number means (⌘⇧L copies the list)">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <mask id="steps-toggle-glyph"><circle cx="10" cy="10" r="7.2" fill="#fff"/><path d="M8.4 8.4 10.4 6.8v6.4M8.6 13.2h3.6" fill="none" stroke="#000" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></mask>
        <circle cx="10" cy="10" r="7.2" fill="currentColor" mask="url(#steps-toggle-glyph)"/>
      </svg>Steps <span class="steps-count"></span>
    </button>
    <button class="copy-only glassy" type="button" title="Copy the image and keep working">Copy <kbd>⌘⇧C</kbd></button>
    <button class="copy primary" type="button">Copy and Close <kbd>⌘C</kbd></button>
  </footer>
  <input class="file-input" type="file" accept="image/png,image/jpeg,image/webp" hidden />
`;
const image = app.querySelector<HTMLImageElement>('.capture')!;
const stage = app.querySelector<HTMLElement>('.stage')!;
const overlay = app.querySelector<SVGSVGElement>('.overlay')!;
const toolbar = app.querySelector<HTMLElement>('.toolbar')!;
const rail = app.querySelector<HTMLElement>('.rail')!;
const tools = app.querySelector<HTMLElement>('.tools')!;
const stepsPanel = app.querySelector<HTMLElement>('.steps')!;
const stepRows = app.querySelector<HTMLElement>('.step-rows')!;
const stepsToggle = app.querySelector<HTMLButtonElement>('.steps-toggle')!;
const weight = app.querySelector<HTMLInputElement>('.weight')!;
const undoButton = app.querySelector<HTMLButtonElement>('.undo')!;
const backButton = app.querySelector<HTMLButtonElement>('.back')!;
const frontButton = app.querySelector<HTMLButtonElement>('.front')!;
const chosenCount = app.querySelector<HTMLElement>('.chosen')!;
const styles = app.querySelector<HTMLElement>('.styles')!;
const looks = app.querySelector<HTMLElement>('.looks')!;
const looksButton = app.querySelector<HTMLButtonElement>('.looks-button')!;
const looksMenu = app.querySelector<HTMLElement>('.looks-menu')!;
const noteModes = app.querySelector<HTMLElement>('.steps-show .segments')!;
const fills = app.querySelector<HTMLElement>('.fills')!;
const removeButton = app.querySelector<HTMLButtonElement>('.remove')!;
const empty = app.querySelector<HTMLElement>('.empty')!;
const copy = app.querySelector<HTMLButtonElement>('.copy')!;
const copyOnly = app.querySelector<HTMLButtonElement>('.copy-only')!;
const shareButton = app.querySelector<HTMLButtonElement>('.share')!;
const saveButton = app.querySelector<HTMLButtonElement>('.save')!;
const start = app.querySelector<HTMLButtonElement>('.start')!;
const choose = app.querySelector<HTMLButtonElement>('.choose')!;
const input = app.querySelector<HTMLInputElement>('.file-input')!;
const message = app.querySelector<HTMLElement>('.message')!;
const settings = app.querySelector<HTMLButtonElement>('.settings')!;
const canvasArea = app.querySelector<HTMLElement>('.canvas')!;
const captureControl = app.querySelector<HTMLElement>('.capture-control')!;
const captureMenu = app.querySelector<HTMLElement>('.capture-menu')!;
const captureMore = app.querySelector<HTMLButtonElement>('.capture-more')!;
const zoomSelect = app.querySelector<HTMLSelectElement>('.zoom-select')!;
const cropBar = app.querySelector<HTMLElement>('.crop-bar')!;
const recents = app.querySelector<HTMLElement>('.recents')!;
const recentList = app.querySelector<HTMLElement>('.recent-list')!;
const cropSize = app.querySelector<HTMLElement>('.crop-size')!;
const abort = new AbortController();
const cleanups: (() => void)[] = [];
let capture: CapturePreview | null = null;
let busy = false;
let copyPending = false;
let disposed = false;
let shown: CapturePreview | null = null;
let mustFlatten = false;
const past: Past[] = [];
let pastId = 1;
/** 'fit' scales the capture to the window; a number is a multiple of the size
 *  the capture was taken at, with the canvas scrolling when that overflows.
 *  Multiples of the captured size rather than of its pixels: a Retina grab has
 *  twice the pixels of the region it came from, so 100% of those pixels would
 *  show every screenshot at double the size it was on screen. */
let zoom: 'fit' | number = 1;
const ZOOMS = [0.25, 0.5, 1, 2, 4];
/** CSS pixels per image pixel at a given zoom. */
function pixelRatio(at: number): number { return at / (capture?.scale || 1); }
const crops: { capture: CapturePreview; dx: number; dy: number; depth: number }[] = [];

// Before anything is hovered: every title in the markup becomes one of Mark's.
adoptTitles();

const layer = new AnnotationLayer(overlay, stage, () => syncTools());
layer.onNumbered = id => offerNote(id);
// Redaction samples the capture, so the layer needs the decoded image, and any
// region drawn before it finished decoding has to be filled in afterwards.
layer.setSource(image);
image.addEventListener('load', () => layer.refreshRedactions());

let flashTimer: ReturnType<typeof setTimeout>;
function flash(text: string) {
  showMessage(text);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if (!disposed) showMessage(null); }, 1800);
}

function showMessage(text: string | null) {
  message.hidden = !text;
  message.querySelector('span')!.textContent = text ?? '';
  settings.hidden = !isTauri || !text?.includes('screen access');
}

/** Selecting an arrow adopts its look, so the swatches and slider always describe
 *  whatever the next edit will affect. */
/** One pill per segmented group, slid under whichever segment is checked. The
 *  group is the pill's offset parent, so a segment's offsets are the pill's
 *  place; the pill takes the segment's size, since a tool is square and a
 *  picker button is not. A pill slides only between two places it has really
 *  been: the first placement after the group appears is a snap, because a
 *  group that is not rendered reports every offset as zero, and a transition
 *  from there would be a slide in from the corner. */
// ---- tooltips ---------------------------------------------------------------
/** Mark's own, because the system's cannot be styled and do not appear on any
 *  schedule worth having: a long wait for the first, none at all for the rest,
 *  and a box that belongs to no app in particular.
 *
 *  Every title inside the editor becomes one of these. A title is also what the
 *  browser would show, so it has to go: the two would appear together. */
const tip = Object.assign(document.createElement('div'), { className: 'tip' });
tip.setAttribute('role', 'tooltip');
tip.hidden = true;
app.append(tip);

/** Long enough not to interrupt someone who knows where they are going. */
const TIP_WAIT = 420;
/** Once one has been shown, the next is all but immediate: hesitating again
 *  between neighbouring buttons is the thing that makes tooltips feel slow. */
const TIP_WAIT_WARM = 60;
/** How long after one hides that still counts as warm. */
const TIP_WARMTH = 500;
let tipTimer: number | undefined, tipWarmUntil = 0, tipFor: Element | null = null;

function adoptTitles(within: ParentNode = app) {
  for (const el of within.querySelectorAll<HTMLElement>('[title]')) {
    el.dataset.tip = el.title;
    el.removeAttribute('title');
  }
}

function placeTip(target: Element) {
  const frame = app.getBoundingClientRect(), at = target.getBoundingClientRect();
  const box = tip.getBoundingClientRect();
  const gap = 8, margin = 6;
  // Beside anything in the rail, where there is no room above or below; under
  // everything else, and over it when that would fall off the bottom.
  const beside = at.left - frame.left < 70;
  let left: number, top: number;
  if (beside) {
    left = at.right - frame.left + gap;
    top = at.top - frame.top + (at.height - box.height) / 2;
    tip.style.setProperty('--tip-from', '0 50%');
  } else {
    left = at.left - frame.left + (at.width - box.width) / 2;
    const under = at.bottom - frame.top + gap;
    const over = at.top - frame.top - box.height - gap;
    top = under + box.height + margin <= frame.height || over < margin ? under : over;
    tip.style.setProperty('--tip-from', top > at.top - frame.top ? '50% 0' : '50% 100%');
  }
  tip.style.left = `${Math.min(Math.max(left, margin), Math.max(margin, frame.width - box.width - margin))}px`;
  tip.style.top = `${Math.min(Math.max(top, margin), Math.max(margin, frame.height - box.height - margin))}px`;
}

function showTip(target: HTMLElement) {
  tipFor = target;
  tip.textContent = target.dataset.tip ?? '';
  tip.hidden = false;
  tip.classList.remove('on');
  placeTip(target);
  void tip.offsetWidth;
  tip.classList.add('on');
}

function hideTip() {
  window.clearTimeout(tipTimer);
  tipTimer = undefined;
  if (!tipFor) return;
  tipFor = null;
  tipWarmUntil = performance.now() + TIP_WARMTH;
  tip.classList.remove('on');
  // Out of the way once it has faded, so it cannot be measured or hovered.
  window.setTimeout(() => { if (!tipFor) tip.hidden = true; }, 140);
}

function wantTip(target: HTMLElement | null, now = false) {
  if (!target || target === tipFor) return;
  // A menu that is open already says what its button is for.
  if (target === looksButton && !looksMenu.hidden) { hideTip(); return; }
  window.clearTimeout(tipTimer);
  const wait = now ? 0 : performance.now() < tipWarmUntil || tipFor ? TIP_WAIT_WARM : TIP_WAIT;
  const showing = !!tipFor;
  tipTimer = window.setTimeout(() => showTip(target), wait);
  // Swapping between neighbours should not leave the old one sitting there.
  if (showing) { tipFor = null; tip.classList.remove('on'); }
}

app.addEventListener('pointerover', event => {
  if ((event as PointerEvent).pointerType === 'touch') return;
  const found = (event.target as Element).closest<HTMLElement>('[data-tip]');
  if (found) wantTip(found); else hideTip();
});
app.addEventListener('pointerleave', hideTip);
app.addEventListener('pointerdown', hideTip, true);
app.addEventListener('focusin', event => {
  const found = (event.target as Element).closest<HTMLElement>('[data-tip]');
  if (found?.matches(':focus-visible')) wantTip(found, true);
});
app.addEventListener('focusout', hideTip);
window.addEventListener('blur', hideTip);

function placeLens(group: HTMLElement) {
  let lens = group.querySelector<HTMLElement>(':scope > .lens');
  if (!lens) { lens = document.createElement('span'); lens.className = 'lens'; group.prepend(lens); }
  const active = group.querySelector<HTMLElement>('[aria-checked="true"]');
  const rendered = !!active && active.offsetParent !== null;   // null while anything above is display: none
  lens.hidden = !rendered;
  if (!active || !rendered) { delete lens.dataset.placed; return; }
  const snap = lens.dataset.placed === undefined;
  if (snap) lens.style.transition = 'none';
  lens.style.width = `${active.offsetWidth}px`;
  lens.style.height = `${active.offsetHeight}px`;
  lens.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
  if (snap) { void lens.offsetWidth; lens.style.transition = ''; lens.dataset.placed = ''; }
}

/** The steps panel: one row per numbered mark, in sequence. Rebuilt from the
 *  layer rather than kept in step with it, so the panel and the badges cannot
 *  drift; the focused row and caret are carried across so typing survives a
 *  rebuild triggered by something else. */
let panelWanted = false;
function syncSteps(focusId?: number) {
  const marks = numbered(layer.annotations);
  // The way back in once the panel has been dismissed, and the only sign the
  // list exists at all when it is closed.
  stepsToggle.hidden = !capture || !marks.length;
  app.querySelector<HTMLElement>('.steps-count')!.textContent = String(marks.length);
  app.querySelector<HTMLElement>('.steps-tally')!.textContent = String(marks.length);
  stepsPanel.hidden = !capture || !marks.length || !panelWanted;
  stepsToggle.setAttribute('aria-expanded', String(!stepsPanel.hidden));
  for (const segment of noteModes.querySelectorAll<HTMLButtonElement>('[data-notes]')) {
    segment.setAttribute('aria-checked', String(segment.dataset.notes === layer.notes));
  }
  placeLens(noteModes);
  stepsToggle.classList.toggle('active', !stepsPanel.hidden);
  // The signature goes with the rows, or reopening would find it unchanged and
  // skip the rebuild that has to happen.
  if (stepsPanel.hidden) { stepRows.replaceChildren(); delete stepRows.dataset.shape; return; }
  // Only when the rows would actually differ. Rebuilding them on every
  // keystroke -- which is what a note being typed causes -- throws away the
  // field under the caret, and with it the browser's own undo for what was
  // typed and anything a paste was in the middle of.
  const shape = marks.map((mark, i) => `${mark.id}:${i + 1}:${mark.color}`).join('|');
  if (stepRows.dataset.shape !== shape) {
    stepRows.dataset.shape = shape;
    const active = document.activeElement as HTMLInputElement | null;
    const keep = active?.classList.contains('step-note')
      ? { id: Number(active.dataset.item), start: active.selectionStart, end: active.selectionEnd } : null;
    stepRows.replaceChildren(...marks.map((mark, i) => {
      const row = document.createElement('label');
      row.className = 'step-row';
      row.innerHTML = `<span class="step-chip" style="--chip:${mark.color};--chip-ink:${inkOn(mark.color)}">${i + 1}</span>`
        + `<input class="step-note" type="text" data-item="${mark.id}" placeholder="Say what to do here" />`;
      row.querySelector<HTMLInputElement>('.step-note')!.value = mark.note ?? '';
      return row;
    }));
    if (keep && focusId === undefined) restoreCaret(keep);
  }
  // The text itself follows the layer, except in the field being typed into,
  // which is already saying it.
  for (const mark of marks) {
    const field = stepRows.querySelector<HTMLInputElement>(`.step-note[data-item="${mark.id}"]`);
    if (field && field !== document.activeElement) field.value = mark.note ?? '';
  }
  if (focusId === undefined) return;
  const wanted = focusId;
  // Stay off the mark being talked about: a panel sitting over the thing you
  // just circled is the one place it must not be.
  const mark = marks.find(item => item.id === wanted);
  if (mark && stepsPanel.dataset.moved === undefined) {
    const [, y] = badgeAt(mark, layer.imageWidth, layer.imageHeight);
    stepsPanel.dataset.at = y > layer.imageHeight * 0.55 ? 'top' : 'bottom';
  }
  const field = stepRows.querySelector<HTMLInputElement>(`.step-note[data-item="${wanted}"]`);
  if (!field) return;
  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
}

/** Put the caret back where it was, when a rebuild has taken its field away. */
function restoreCaret(keep: { id: number; start: number | null; end: number | null }) {
  const field = stepRows.querySelector<HTMLInputElement>(`.step-note[data-item="${keep.id}"]`);
  if (!field) return;
  field.focus();
  if (keep.start !== null) field.setSelectionRange(keep.start, keep.end);
}

/** Drag the panel out of the way by its grab bar. Once it has been moved it
 *  stays where it was put: the flip between top and bottom is Mark guessing,
 *  and a guess should not overrule a decision. Kept inside the window, so it
 *  cannot be dropped somewhere it can never be reached. */
const PANEL_MARGIN = 8;
/** Near enough an edge to cling to it. */
const PANEL_SNAP = 28;
/** The canvas's box in the panel's own coordinates, which are the window's. The
 *  panel belongs over the capture, so that is what it is kept inside: the
 *  window would let it sit on the tool rail, where it covers the tools. */
function panelRoom() {
  const frame = app.getBoundingClientRect(), canvas = stage.parentElement!.getBoundingClientRect();
  return { left: canvas.left - frame.left, top: canvas.top - frame.top,
           width: canvas.width, height: canvas.height };
}
function placePanel(left: number, top: number) {
  const room = panelRoom(), panel = stepsPanel.getBoundingClientRect();
  const least = { x: room.left + PANEL_MARGIN, y: room.top + PANEL_MARGIN };
  const most = { x: Math.max(least.x, room.left + room.width - panel.width - PANEL_MARGIN),
                 y: Math.max(least.y, room.top + room.height - panel.height - PANEL_MARGIN) };
  // Dragged near a side, it clings to it, which is both tidier than almost-flush
  // and the answer to "can it attach to an edge". Dragging away lets go.
  if (left <= least.x + PANEL_SNAP) { left = least.x; stepsPanel.dataset.dock = 'left'; }
  else if (left >= most.x - PANEL_SNAP) { left = most.x; stepsPanel.dataset.dock = 'right'; }
  else delete stepsPanel.dataset.dock;
  stepsPanel.dataset.moved = '';
  stepsPanel.style.left = `${Math.min(Math.max(left, least.x), most.x)}px`;
  stepsPanel.style.top = `${Math.min(Math.max(top, least.y), most.y)}px`;
  stepsPanel.style.bottom = 'auto';
}

/** Follow the pointer until it is let go, through one element's capture. */
function whileDragging(on: HTMLElement, event: PointerEvent, move: (moved: PointerEvent) => void) {
  on.setPointerCapture(event.pointerId);
  event.preventDefault();
  const done = () => {
    on.removeEventListener('pointermove', move);
    on.removeEventListener('pointerup', done);
    on.removeEventListener('pointercancel', done);
  };
  on.addEventListener('pointermove', move);
  on.addEventListener('pointerup', done);
  on.addEventListener('pointercancel', done);
}

// The whole title row moves it, which is what makes the moving obvious.
app.querySelector<HTMLElement>('.steps-head')!.addEventListener('pointerdown', event => {
  if ((event.target as Element).closest('button')) return;
  const head = event.currentTarget as HTMLElement;
  const room = app.getBoundingClientRect(), panel = stepsPanel.getBoundingClientRect();
  const offsetX = event.clientX - panel.left, offsetY = event.clientY - panel.top;
  whileDragging(head, event, moved =>
    placePanel(moved.clientX - room.left - offsetX, moved.clientY - room.top - offsetY));
});

/** Wide enough for a sentence, never wider than there is room for. */
const PANEL_WIDTH = { least: 250, most: 720 };
for (const edge of app.querySelectorAll<HTMLElement>('.steps-edge')) {
  edge.addEventListener('pointerdown', event => {
    const frame = app.getBoundingClientRect(), panel = stepsPanel.getBoundingClientRect();
    const fromLeft = edge.dataset.edge === 'left';
    const anchor = fromLeft ? panel.right : panel.left;
    whileDragging(edge, event, moved => {
      const wanted = fromLeft ? anchor - moved.clientX : moved.clientX - anchor;
      const width = Math.min(Math.max(wanted, PANEL_WIDTH.least),
                             Math.min(PANEL_WIDTH.most, panelRoom().width - PANEL_MARGIN * 2));
      stepsPanel.style.width = `${width}px`;
      // Anchored by the edge that is not being dragged.
      placePanel(fromLeft ? anchor - frame.left - width : panel.left - frame.left,
                 panel.top - frame.top);
    });
  });
}

const fold = app.querySelector<HTMLButtonElement>('.steps-fold')!;
/** The width it had before it was folded, since folded it shrinks to its title. */
let unfoldedWidth = '';
on(fold, 'click', () => {
  const folded = stepsPanel.dataset.folded === undefined;
  if (folded) {
    stepsPanel.dataset.folded = '';
    unfoldedWidth = stepsPanel.style.width;
    // A title-wide bar, not a wide bar with a title in it.
    stepsPanel.style.width = 'fit-content';
  } else {
    delete stepsPanel.dataset.folded;
    stepsPanel.style.width = unfoldedWidth;
  }
  fold.setAttribute('aria-expanded', String(!folded));
  fold.title = folded ? 'Show the list' : 'Minimise';
  // Folding changes its height, so a panel sitting at the foot would drift.
  if (stepsPanel.dataset.moved !== undefined) {
    placePanel(parseFloat(stepsPanel.style.left), parseFloat(stepsPanel.style.top));
  }
});
on(app.querySelector<HTMLButtonElement>('.steps-close')!, 'click', () => { panelWanted = false; syncSteps(); });

// A window that changed size may have left it hanging over an edge.
window.addEventListener('resize', () => {
  if (stepsPanel.hidden || stepsPanel.dataset.moved === undefined) return;
  placePanel(parseFloat(stepsPanel.style.left), parseFloat(stepsPanel.style.top));
});

/** Open the panel on a mark just made: their "circled something and it
 *  immediately started a caption". */
function offerNote(id: number) {
  panelWanted = true;
  // There is nothing to type into while it is folded, and a note was asked for.
  if (stepsPanel.dataset.folded !== undefined) fold.click();
  syncSteps(id);
}

on(stepRows, 'input', event => {
  const field = event.target as HTMLInputElement;
  if (!field.classList.contains('step-note')) return;
  layer.setNote(Number(field.dataset.item), field.value);
});
on(stepRows, 'keydown', event => {
  const key = (event as KeyboardEvent).key;
  if (key !== 'Enter' && key !== 'Escape') return;
  event.preventDefault();
  // Enter moves to the next mark; Escape puts the panel away without losing what is typed.
  const fields = [...stepRows.querySelectorAll<HTMLInputElement>('.step-note')];
  const next = fields[fields.indexOf(event.target as HTMLInputElement) + 1];
  if (key === 'Enter' && next) next.focus();
  else {
    // Escape backs out of the mark, not only its row: leaving it selected would
    // send the next colour or style change to it from across the window.
    (event.target as HTMLInputElement).blur();
    panelWanted = false;
    layer.deselect();
    syncSteps();
  }
});
app.querySelector<HTMLButtonElement>('.steps-copy')!.addEventListener('click', () => void copyList());
// The panel is a popover over the canvas, so pressing anything else puts it
// away -- otherwise it sits between you and the part of the image underneath
// it. Making another numbered mark opens it again on that mark's row, and the
// footer's count opens it for review.
//
// Blurring matters on its own: the layer calls preventDefault on pointerdown,
// so a click on the canvas does not move focus by itself and the note field
// would keep it, turning a Delete meant for the selected mark into a Delete
// inside the text.
document.addEventListener('pointerdown', event => {
  // The footer's own count is not "anything else": it has to be able to close
  // the panel, and it cannot if this has already closed it a moment before.
  if ((event.target as Element).closest?.('.steps, .steps-toggle')) return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.classList.contains('step-note')) active.blur();
  if (!panelWanted) return;
  panelWanted = false;
  syncSteps();
}, true);

on(noteModes, 'click', event => {
  const mode = (event.target as Element).closest<HTMLButtonElement>('[data-notes]')?.dataset.notes as NoteMode | undefined;
  if (!mode || mode === layer.notes) return;
  layer.notes = mode;
  // Drawn words are part of the picture, so a plain capture can no longer be
  // copied as its original bytes.
  mustFlatten = true;
  layer.render(); syncTools();
});

on(stepsToggle, 'click', () => {
  panelWanted = !panelWanted;
  syncSteps(panelWanted ? numbered(layer.annotations)[0]?.id : undefined);
});

/** The list as text. Its own action rather than a second flavour on the image
 *  copy: one clipboard write cannot be pasted as the picture and then as the
 *  words -- the second paste would only repeat the first. */
/** Said after an image copy when there is a list to go with it: a nudge, not
 *  magic. The image and the list are two clipboard writes because they have to
 *  be -- one write cannot be pasted as the picture and then as the words. */
function listHint(): string {
  const n = numbered(layer.annotations).length;
  return n ? ` ⌘⇧L copies the ${n} ${n === 1 ? 'step' : 'steps'} as text.` : '';
}

async function copyList() {
  const marks = numbered(layer.annotations);
  if (!marks.length) { flash('Nothing numbered yet. Drop a badge, or circle something with Number them on.'); return; }
  const text = stepList(layer.annotations);
  try {
    if (isTauri) await command('copy_text', { text });
    else await navigator.clipboard.writeText(text);
    flash(`${marks.length} ${marks.length === 1 ? 'step' : 'steps'} copied as text. Paste it beside the image.`);
  } catch (error) { report(error); }
}

function syncTools() {
  const picked = layer.selection;
  // Say what a colour or size change is about to land on. Restyling the thing
  // just drawn is right, but it should never be a surprise.
  chosenCount.hidden = picked.length === 0;
  chosenCount.textContent = picked.length === 1
    ? `${describe(picked[0].kind)} selected`
    : `${picked.length} selected`;
  // The pickers describe what a change will land on: the selection when there
  // is one -- its last mark, which is where colour and size are read from too --
  // and the tool in hand when there is not. So at most one group shows, which
  // is also what keeps the bar inside the window: a mixed selection used to
  // show both, and pushed Delete off the end. A step points with an arrow of
  // its own, so the arrow's pickers are its business too.
  const source = layer.styleSource;
  const pointing = source ? takesLooks(source) : layer.tool === 'arrow';
  styles.hidden = !pointing;
  looks.hidden = !pointing;
  if (source && takesLooks(source)) {
    layer.style.arrow = styleOf(source);
    layer.style.shadow = hasLook(source, 'shadow');
    layer.style.border = hasLook(source, 'border');
  }
  for (const button of app.querySelectorAll<HTMLButtonElement>('.style[data-style]')) {
    const active = button.dataset.style === layer.style.arrow;
    button.setAttribute('aria-checked', String(active));
    button.classList.toggle('active', active);
  }
  looksButton.classList.toggle('active', layer.style.shadow || layer.style.border);
  for (const row of looksMenu.querySelectorAll<HTMLButtonElement>('[data-look]')) {
    row.setAttribute('aria-checked', String(layer.style[row.dataset.look as Look]));
  }
  if (looks.hidden) closeLooksMenu();
  const shapes = picked.filter(fillable);
  const shaping = source ? fillable(source) : layer.tool === 'box' || layer.tool === 'ellipse';
  fills.hidden = !shaping;
  if (source && fillable(source)) layer.style.fill = fillOf(source);
  // Selecting a numbered mark puts its slot on the numbered variant, so the rail
  // goes on describing the next edit the way the toolbar's pickers do.
  const numberable = picked.filter(item => fillable(item) || item.kind === 'arrow' || item.kind === 'step');
  if (numberable.length) {
    const last = numberable[numberable.length - 1];
    const on = last.kind === 'step' || (isShape(last) && last.numbered === true);
    const slot = SLOTS.findIndex(choices => choices[0].id === (last.kind === 'step' ? 'arrow' : last.kind));
    if (slot >= 0 && SLOTS[slot].length > 1 && worn[slot] !== (on ? 1 : 0)) wear(slot, on ? 1 : 0);
  }
  // Preview the shape in hand: the selection's if there is one, else the tool's.
  fills.dataset.shape = shapes.length ? shapes[shapes.length - 1].kind : layer.tool === 'ellipse' ? 'ellipse' : 'box';
  for (const button of app.querySelectorAll<HTMLButtonElement>('.style[data-fill]')) {
    const active = button.dataset.fill === layer.style.fill;
    button.setAttribute('aria-checked', String(active));
    button.classList.toggle('active', active);
  }
  const selected = layer.styleSource;
  if (selected) {
    layer.style.color = selected.color;
    layer.style.scale = selected.kind === 'text'
      ? selected.size / textSize(layer.base)
      : selected.weight / layer.base;
  }
  weight.value = layer.style.scale.toFixed(2);
  syncSteps();
  for (const swatch of app.querySelectorAll<HTMLButtonElement>('.swatch')) {
    const active = swatch.dataset.color === layer.style.color;
    swatch.setAttribute('aria-checked', String(active));
    swatch.classList.toggle('active', active);
  }
  for (const button of app.querySelectorAll<HTMLButtonElement>('.tool')) {
    const slot = Number(button.dataset.slot);
    const choice = SLOTS[slot][worn[slot]];
    const active = choice.id === layer.tool && !!choice.numbered === layer.style.numbered;
    button.setAttribute('aria-checked', String(active));
    button.classList.toggle('active', active);
  }
  // Rebuilt only when it would differ: this runs on every change to the drawing,
  // and the step's number changes with every mark.
  const next = numbered(layer.annotations).length + 1;
  const wantsCursor = layer.tool !== 'arrow' ? ''
    : `${layer.style.numbered ? `step|${next}` : 'arrow'}|${layer.style.arrow}|${layer.style.color}`;
  if (overlay.dataset.cursor !== wantsCursor) {
    overlay.dataset.cursor = wantsCursor;
    overlay.style.cursor = wantsCursor
      ? toolCursor(layer.tool, layer.style.numbered, layer.style.arrow, layer.style.color, next) : '';
  }
  overlay.classList.toggle('text-tool', layer.tool === 'text');
  overlay.classList.toggle('draw-tool', layer.tool !== 'arrow' && layer.tool !== 'text' && layer.tool !== 'pen');
  overlay.classList.toggle('pen-tool', layer.tool === 'pen');
  overlay.classList.toggle('crop-tool', layer.tool === 'crop');
  const crop = layer.pendingCrop;
  cropBar.hidden = !crop;
  if (crop) cropSize.textContent = `Crop to ${Math.round(crop.width)} × ${Math.round(crop.height)} px`;
  undoButton.disabled = !layer.canUndo && !crops.length;
  removeButton.disabled = picked.length === 0 || layer.isEditing;
  backButton.disabled = frontButton.disabled = picked.length === 0 || layer.isEditing;
  for (const group of [tools, styles, fills]) placeLens(group);
}

function render() {
  if (isTauri) void command('set_glass', { visible: !!capture }).catch(() => {});
  stage.hidden = !capture;
  toolbar.hidden = !capture;
  rail.hidden = !capture;
  empty.hidden = !!capture;
  if (capture) {
    // A different capture means a different drawing surface. A crop swaps the
    // image in place and updates `shown` itself, so it is not mistaken for one.
    if (capture !== shown) {
      if (shown) remember(shown);
      image.src = capture.dataUrl;
      stage.style.setProperty('--ratio', `${capture.width} / ${capture.height}`);
      layer.setImage(capture.width, capture.height);
      shown = capture; mustFlatten = false; crops.length = 0; zoom = startingZoom(capture);
      // A different capture is a differently sized window, so a position chosen
      // for the last one means nothing here.
      delete stepsPanel.dataset.moved;
      stepsPanel.style.left = ''; stepsPanel.style.top = ''; stepsPanel.style.bottom = '';
    }
    image.alt = `Captured screenshot, ${capture.width} by ${capture.height} pixels`;
  } else {
    // The capture is on its way out, so keep it before the layer is reset.
    if (shown) { remember(shown); shown = null; mustFlatten = false; crops.length = 0; }
    image.removeAttribute('src');
  }
  drawRecents();
  app.querySelector('.dimensions')!.textContent = capture ? `${capture.width} × ${capture.height} px` : '';
  // With nothing captured every control in the footer is hidden, which left an
  // empty band of chrome across the bottom of the empty state.
  app.querySelector<HTMLElement>('footer')!.hidden = !capture;
  copy.hidden = !capture;
  copyOnly.hidden = !capture;
  shareButton.hidden = saveButton.hidden = !capture || !isTauri;
  app.querySelector<HTMLElement>('.exports')!.hidden = !capture || !isTauri;
  shareButton.disabled = saveButton.disabled = busy || copyPending;
  zoomSelect.parentElement!.hidden = !capture;
  applyZoom();
  copy.disabled = busy || copyPending;
  copyOnly.disabled = busy || copyPending;
  start.disabled = busy;
  start.firstChild!.textContent = isTauri ? (busy ? 'Selecting… ' : 'Capture Region ') : 'Choose image… ';
  start.querySelector('kbd')!.hidden = !isTauri;
  syncTools();
}

let revision = 0;
async function refresh() {
  const request = ++revision;
  try {
    const snapshot = await command<Snapshot>('current_capture');
    if (disposed || request !== revision) return;
    capture = snapshot.capture; busy = snapshot.busy;
    showMessage(snapshot.error); render();
  } catch (error) { report(error); }
}
function report(error: unknown) { console.error('[Mark]', error); showMessage(String(error)); }

async function dismiss() {
  if (busy || copyPending) return;
  if (isTauri) { await command('dismiss_editor'); }
  capture = null; showMessage(null); render(); start.focus();
}

/** Flatten the capture and its arrows at natural resolution. */
async function flatten(): Promise<HTMLCanvasElement> {
  const source = new Image();
  source.src = capture!.dataUrl;
  await source.decode();
  const canvas = document.createElement('canvas');
  canvas.width = capture!.width; canvas.height = capture!.height;
  const context = canvas.getContext('2d')!;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  drawAnnotations(context, layer.annotations, { source, notes: layer.notes });
  return canvas;
}

/** The name macOS itself would give a screenshot, so a saved file lands
 *  somewhere recognisable in a folder full of them. */
function suggestedName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `Mark ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + ` at ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}.png`;
}

/** Saving and sharing always send the flattened image: a file should be what is
 *  on screen, crop and annotations included. */
async function exportImage(via: 'save_image' | 'share_image') {
  if (!capture || busy || copyPending) return;
  copyPending = true; render();
  try {
    const png = (await flatten()).toDataURL('image/png').split(',')[1];
    const saved = await command<string | null>(via, { png, name: suggestedName() });
    if (via === 'save_image') flash(saved ? `Saved as ${saved}.` : 'Not saved.');
  } catch (error) { report(error); }
  finally { copyPending = false; render(); }
}

async function copyCapture(close = true) {
  if (!capture || busy || copyPending) return;
  copyPending = true; render(); showMessage(null);
  try {
    if (isTauri) {
      // An untouched capture keeps its original bytes; only a drawing re-encodes.
      // A crop makes the original bytes wrong, so it forces a re-encode too.
      if (layer.empty && !mustFlatten) await command('copy_capture', { close });
      else await command('copy_edited', { png: (await flatten()).toDataURL('image/png').split(',')[1], close });
      if (close) capture = null; else flash(`Copied to clipboard.${listHint()}`);
    } else {
      // Start clipboard.write inside the gesture; Safari accepts a promised Blob.
      const png = layer.empty
        ? fetch(capture.dataUrl).then(response => response.blob())
        : flatten().then(canvas => new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('The image could not be encoded.'))), 'image/png')));
      await copyThenDismiss(async () => {
        if (!navigator.clipboard?.write) throw new Error('Image copying needs clipboard access on localhost or HTTPS.');
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      }, () => { if (close) capture = null; });
      flash(`Copied to clipboard.${listHint()}`);
    }
  } catch (error) { report(error); }
  finally { copyPending = false; render(); }
}

function on<K extends keyof HTMLElementEventMap>(element: HTMLElement, name: K, handler: (event: HTMLElementEventMap[K]) => void) {
  element.addEventListener(name, handler, { signal: abort.signal });
}
on(copy, 'click', () => { void copyCapture(true); });
on(copyOnly, 'click', () => { void copyCapture(false); });
on(saveButton, 'click', () => { void exportImage('save_image'); });
on(shareButton, 'click', () => { void exportImage('share_image'); });
on(start, 'click', () => startCapture('region'));
on(app.querySelector<HTMLButtonElement>('.capture-go')!, 'click', () => startCapture('region'));
on(captureMore, 'click', event => {
  event.stopPropagation();
  const open = captureMenu.hidden;
  captureMenu.hidden = !open;
  captureMore.setAttribute('aria-expanded', String(open));
});
on(captureMenu, 'click', event => {
  const mode = (event.target as Element).closest<HTMLButtonElement>('[data-mode]')?.dataset.mode;
  if (mode) startCapture(mode as 'region' | 'display' | 'timed');
});
document.addEventListener('pointerdown', event => {
  if (!captureMenu.hidden && !captureControl.contains(event.target as Node)) closeCaptureMenu();
}, { signal: abort.signal });
on(zoomSelect, 'change', () => setZoom(zoomSelect.value === 'fit' ? 'fit' : Number(zoomSelect.value)));
on(choose, 'click', () => input.click());
on(settings, 'click', () => { void command('open_screen_settings').catch(report); });
on(input, 'change', () => { void loadFile().catch(report); });
/** Take up a slot's variant: the tool it is, and whether what it draws carries a
 *  number. This chooses the next mark and nothing else -- it used to restyle
 *  the selection too, so drawing a numbered arrow and then picking up the Box
 *  tool turned the arrow plain and took its number. Numbering a mark that is
 *  already drawn is the slot menu's to do, and it says so with setNumbered. */
function wear(slot: number, variant: number) {
  worn[slot] = variant;
  const choice = SLOTS[slot][variant];
  const button = rail.querySelector<HTMLButtonElement>(`.tool[data-slot="${slot}"]`)!;
  button.querySelector('svg')!.innerHTML = choice.art;
  button.querySelector('.sr')!.textContent = choice.name;
  if (button.dataset.tip !== undefined) button.dataset.tip = choice.name;
  layer.tool = choice.id;
  layer.style.numbered = !!choice.numbered;
  syncTools();
}

// ---- the slot menu ------------------------------------------------------------
/** Press and hold, or right-click, or the right arrow from the keyboard: the
 *  ways a tool group has always been opened, since the marker in the corner is
 *  too small to be a target of its own. */
const toolMenu = app.querySelector<HTMLElement>('.tool-menu')!;
let menuFor: HTMLButtonElement | null = null;
function closeToolMenu() {
  if (!menuFor) return;
  menuFor.setAttribute('aria-expanded', 'false');
  menuFor = null;
  toolMenu.hidden = true;
  toolMenu.replaceChildren();
}
function openToolMenu(button: HTMLButtonElement) {
  const slot = Number(button.dataset.slot);
  if (SLOTS[slot].length < 2) return;
  closeToolMenu();
  menuFor = button;
  button.setAttribute('aria-expanded', 'true');
  toolMenu.replaceChildren(...SLOTS[slot].map((choice, variant) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(variant === worn[slot]));
    item.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${choice.art}</svg><span>${choice.name}</span>`;
    item.addEventListener('click', () => {
      wear(slot, variant);
      // Choosing a way of drawing with something selected draws that the new
      // way -- but only what this slot draws: an arrow's numbering is nothing
      // to do with a box that happens to be selected alongside it.
      layer.setNumbered(!!choice.numbered,
        choice.id === 'arrow' ? ['arrow', 'step'] : [choice.id as Annotation['kind']]);
      layer.deselect(); closeToolMenu();
    });
    return item;
  }));
  toolMenu.hidden = false;
  const at = button.getBoundingClientRect(), frame = app.getBoundingClientRect();
  toolMenu.style.left = `${at.right - frame.left + 8}px`;
  toolMenu.style.top = `${Math.min(at.top - frame.top, frame.height - toolMenu.offsetHeight - 8)}px`;
  toolMenu.querySelector('button')?.focus();
}

/** Resting on a slot opens it. Long enough not to spray menus at someone
 *  running the pointer down the rail to reach the crop; short once one is open,
 *  since by then the menus are what is being read. */
const SLOT_WAIT = 380, SLOT_WAIT_WARM = 90, SLOT_LINGER = 180;
let slotTimer: number | undefined;
function wantToolMenu(button: HTMLButtonElement | null) {
  window.clearTimeout(slotTimer);
  if (!button || button === menuFor) return;
  if (!button.hasAttribute('aria-haspopup')) { if (menuFor) slotTimer = window.setTimeout(closeToolMenu, SLOT_LINGER); return; }
  slotTimer = window.setTimeout(() => openToolMenu(button), menuFor ? SLOT_WAIT_WARM : SLOT_WAIT);
}
/** Leaving does not close at once: the menu sits a few pixels off the rail, and
 *  the pointer is over neither while it crosses. */
function letToolMenuGo() {
  window.clearTimeout(slotTimer);
  slotTimer = window.setTimeout(closeToolMenu, SLOT_LINGER);
}
on(rail, 'pointerover', event => {
  if ((event as PointerEvent).pointerType === 'touch') return;
  wantToolMenu((event.target as Element).closest<HTMLButtonElement>('.tool'));
});
rail.addEventListener('pointerleave', letToolMenuGo);
toolMenu.addEventListener('pointerenter', () => window.clearTimeout(slotTimer));
toolMenu.addEventListener('pointerleave', letToolMenuGo);

rail.addEventListener('contextmenu', event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('.tool');
  if (!button || Number.isNaN(Number(button.dataset.slot))) return;
  event.preventDefault();
  openToolMenu(button);
});
on(rail, 'keydown', event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('.tool');
  if (button && (event as KeyboardEvent).key === 'ArrowRight') { event.preventDefault(); openToolMenu(button); }
});
document.addEventListener('pointerdown', event => {
  if (menuFor && !(event.target as Element).closest('.tool-menu, .tool')) closeToolMenu();
}, true);

on(rail, 'click', event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('.tool');
  if (!button) return;
  // Clicking takes the slot as it stands; its menu, open or not, is for
  // changing which way that is.
  wear(Number(button.dataset.slot), worn[Number(button.dataset.slot)]);
  layer.deselect();
});
on(toolbar, 'click', event => {
  const element = event.target as Element;
  const style = element.closest<HTMLButtonElement>('.style');
  if (style?.dataset.style) { layer.restyle({ arrow: style.dataset.style as ArrowStyle }); return; }
  if (style?.dataset.fill) { layer.restyle({ fill: style.dataset.fill as ShapeFill }); return; }
  const swatch = element.closest<HTMLButtonElement>('.swatch');
  if (!swatch?.dataset.color) return;
  layer.restyle({ color: swatch.dataset.color });
});
on(weight, 'input', () => layer.restyle({ scale: Number(weight.value) }));

// ---- shadow and border ------------------------------------------------------------
/** A menu rather than two more buttons: the bar has room for one control here
 *  at its narrowest, and the two are independent, which a picker's one sliding
 *  highlight cannot say. It stays open while you try them, since trying them
 *  is the point, and it restyles the selection like every other picker. */
function openLooksMenu() {
  looksMenu.hidden = false;
  looksButton.setAttribute('aria-expanded', 'true');
  hideTip();
  looksMenu.querySelector<HTMLButtonElement>('[data-look]')?.focus();
}
function closeLooksMenu(refocus = false) {
  if (looksMenu.hidden) return;
  looksMenu.hidden = true;
  looksButton.setAttribute('aria-expanded', 'false');
  if (refocus) looksButton.focus();
}
on(looksButton, 'click', () => { if (looksMenu.hidden) openLooksMenu(); else closeLooksMenu(); });
on(looksMenu, 'click', event => {
  const look = (event.target as Element).closest<HTMLButtonElement>('[data-look]')?.dataset.look as Look | undefined;
  if (look) layer.restyle({ [look]: !layer.style[look] });
});
on(looksMenu, 'keydown', event => {
  const key = (event as KeyboardEvent).key;
  if (key !== 'ArrowDown' && key !== 'ArrowUp') return;
  // Up and down walk the rows, and go no further: arrow keys mean something to
  // the editor behind the menu as well.
  event.preventDefault();
  event.stopPropagation();
  const rows = [...looksMenu.querySelectorAll<HTMLButtonElement>('[data-look]')];
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  rows[(at + (key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
});
document.addEventListener('pointerdown', event => {
  if (!looksMenu.hidden && !looks.contains(event.target as Node)) closeLooksMenu();
}, { signal: abort.signal });
on(undoButton, 'click', () => { stepBack(); });
on(app.querySelector<HTMLButtonElement>('.crop-apply')!, 'click', () => { void applyCrop().catch(report); });
on(app.querySelector<HTMLButtonElement>('.crop-cancel')!, 'click', () => layer.clearCrop());
on(removeButton, 'click', () => { layer.deleteSelected(); });
on(backButton, 'click', () => { layer.reorder('backward'); });
on(frontButton, 'click', () => { layer.reorder('forward'); });

// The overlay scales with the window; handles are sized from the drawn width.
const observer = new ResizeObserver(() => layer.measure());
observer.observe(stage);
cleanups.push(() => observer.disconnect());

/** Actual size, unless that would not fit: a capture bigger than the window is
 *  better met fitted than already scrolled. */
function startingZoom(next: CapturePreview): 'fit' | number {
  const room = canvasArea.getBoundingClientRect();
  if (!room.width || !room.height) return 1;      // before first layout
  const ratio = 1 / (next.scale || 1);
  const fits = next.width * ratio <= room.width - 52 && next.height * ratio <= room.height - 52;
  return fits ? 1 : 'fit';
}

function applyZoom() {
  const fitted = zoom === 'fit';
  stage.classList.toggle('zoomed', !fitted);
  canvasArea.classList.toggle('scrolls', !fitted);
  if (!fitted && capture) {
    const ratio = pixelRatio(zoom as number);
    stage.style.width = `${Math.round(capture.width * ratio)}px`;
    stage.style.height = `${Math.round(capture.height * ratio)}px`;
  } else {
    stage.style.width = ''; stage.style.height = '';
  }
  zoomSelect.value = fitted ? 'fit' : String(zoom);
  layer.measure();
}

function setZoom(next: 'fit' | number) { zoom = next; applyZoom(); }

/** Step through the fixed stops. From Fit, start at whatever is nearest to how
 *  the capture is actually being shown, so the first press is not a jump. */
function stepZoom(direction: 1 | -1) {
  if (!capture) return;
  const showing = zoom === 'fit'
    ? ((stage.getBoundingClientRect().width || capture.width) / capture.width) * (capture.scale || 1)
    : zoom;
  const index = ZOOMS.findIndex(stop => direction > 0 ? stop > showing + 0.001 : stop < showing - 0.001);
  if (direction > 0) setZoom(index === -1 ? ZOOMS[ZOOMS.length - 1] : ZOOMS[index]);
  else {
    const below = ZOOMS.filter(stop => stop < showing - 0.001);
    setZoom(below.length ? below[below.length - 1] : ZOOMS[0]);
  }
}

/** Start a capture. In the browser preview there is nothing native to call, so
 *  every mode falls back to the file chooser, as the empty state does. */
function startCapture(mode: 'region' | 'display' | 'timed') {
  closeCaptureMenu();
  if (!isTauri) { input.click(); return; }
  const call = mode === 'display'
    ? command('capture_display', {})
    : command('capture_region', mode === 'timed' ? { delay: 5 } : {});
  void call.catch(report);
}

function closeCaptureMenu() {
  captureMenu.hidden = true;
  captureMore.setAttribute('aria-expanded', 'false');
}

/** A small picture of the capture as it stood, drawing and all, so a recent
 *  entry is recognisable at a glance rather than a grey rectangle. */
function thumbnail(width = 168): string {
  const scale = Math.min(1, width / (image.naturalWidth || width));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d')!;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  context.scale(scale, scale);
  // The image's own size, which badges are kept inside: the canvas is smaller.
  drawAnnotations(context, layer.annotations,
                  { source: image, width: image.naturalWidth, height: image.naturalHeight });
  return canvas.toDataURL('image/png');
}

/** Hold on to a capture that is leaving the editor. */
function remember(leaving: CapturePreview) {
  if (!image.complete || !image.naturalWidth) return;
  past.unshift({ id: pastId++, capture: leaving, thumb: thumbnail(),
                 annotations: layer.annotations.map(item => ({ ...item })) });
  let total = 0;
  for (let index = 0; index < past.length; index++) {
    total += past[index].capture.dataUrl.length;
    if (index >= KEPT || total > KEPT_CHARS) { past.length = Math.max(1, index); break; }
  }
}

/** Bring a kept capture back, drawing and all. Rust no longer holds it, so
 *  copying will go through the flatten path from here on. */
function restore(entry: Past) {
  capture = entry.capture;
  mustFlatten = true;
  crops.length = 0;
  image.src = entry.capture.dataUrl;
  stage.style.setProperty('--ratio', `${entry.capture.width} / ${entry.capture.height}`);
  layer.setImage(entry.capture.width, entry.capture.height);
  layer.load(entry.annotations);
  shown = entry.capture;
  zoom = startingZoom(entry.capture);
  render();
}

function drawRecents() {
  recents.hidden = !!capture || past.length === 0;
  if (recents.hidden) { recentList.replaceChildren(); return; }
  recentList.replaceChildren(...past.map(entry => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent';
    button.title = `Reopen this ${entry.capture.width} × ${entry.capture.height} capture`;
    const thumb = document.createElement('img');
    thumb.src = entry.thumb; thumb.alt = '';
    const size = document.createElement('span');
    size.textContent = `${entry.capture.width} × ${entry.capture.height}`;
    button.append(thumb, size);
    button.addEventListener('click', () => restore(entry), { signal: abort.signal });
    return button;
  }));
}

/** Trim the capture to the pending rectangle. The drawing comes along, shifted
 *  to match, so a crop never silently discards work. */
async function applyCrop() {
  const crop = layer.pendingCrop;
  if (!crop || !capture || crop.width < 1 || crop.height < 1) return;
  const source = new Image();
  source.src = capture.dataUrl;
  await source.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(crop.width); canvas.height = Math.round(crop.height);
  canvas.getContext('2d')!.drawImage(source, Math.round(crop.x), Math.round(crop.y), canvas.width, canvas.height,
                                     0, 0, canvas.width, canvas.height);
  crops.push({ capture, dx: crop.x, dy: crop.y, depth: layer.undoDepth });
  layer.shiftBy(-crop.x, -crop.y);
  capture = { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
  mustFlatten = true;
  swapImage(capture);
}

function swapImage(next: CapturePreview) {
  image.src = next.dataUrl;
  stage.style.setProperty('--ratio', `${next.width} / ${next.height}`);
  layer.resize(next.width, next.height);
  shown = next;
  render();
}

/** Undo the most recent thing, whichever kind it was: a crop only counts as
 *  most recent while no drawing has happened since. */
function stepBack() {
  const last = crops.at(-1);
  if (last && layer.undoDepth === last.depth) {
    crops.pop();
    layer.shiftBy(last.dx, last.dy);
    capture = last.capture;
    mustFlatten = crops.length > 0 || mustFlatten;
    swapImage(last.capture);
    return;
  }
  layer.undo();
}

async function loadFile() {
  const file = input.files?.[0]; if (!file) return;
  if (file.size > 50 * 1024 * 1024) throw new Error('Choose an image smaller than 50 MB.');
  const url = URL.createObjectURL(file);
  try {
    const loaded = new Image(); loaded.src = url; await loaded.decode();
    if (loaded.naturalWidth * loaded.naturalHeight > 80_000_000) throw new Error('This image is too large to preview.');
    const canvas = document.createElement('canvas');
    canvas.width = loaded.naturalWidth; canvas.height = loaded.naturalHeight;
    canvas.getContext('2d')!.drawImage(loaded, 0, 0);
    capture = { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
    showMessage(null); render();
  } finally { URL.revokeObjectURL(url); input.value = ''; }
}

document.addEventListener('keydown', event => {
  const key = event.key.toLowerCase();
  // Only real text entry may swallow Backspace. A range or file input must not,
  // or adjusting the size control would quietly disable Delete.
  const target = event.target as HTMLElement | null;
  const typing = target instanceof HTMLTextAreaElement || target?.isContentEditable === true ||
    (target instanceof HTMLInputElement && !['range', 'checkbox', 'radio', 'file', 'button'].includes(target.type));
  if (layer.isEditing) return;
  // An open slot menu owns Escape entirely: it is a popover, and the editor's
  // own Escape would back out of the capture behind it.
  if (key === 'escape' && menuFor) {
    event.preventDefault();
    const button = menuFor;
    closeToolMenu();
    button.focus();
    return;
  }
  if (key === 'escape' && !looksMenu.hidden) {
    event.preventDefault();
    closeLooksMenu(true);
    return;
  }
  // A text field owns the keys that edit text. Without this, typing a note in
  // the steps panel meant ⌘C copied the screenshot, ⌘V pasted an annotation
  // rather than the clipboard's text -- and having been prevented, never
  // pasted it at all -- ⌘A selected every mark, ⌘Z undid a drawing, and Escape
  // closed the capture. The text tool never had this because its own editing
  // short-circuits above; this is the same courtesy for every other field.
  // ⇧⌘C stays the app's: copying the image is not a text shortcut.
  //
  // ⌘Z is the one with a condition: an empty field has no typing to undo, and
  // a field Mark focused itself the instant a mark was made is exactly where
  // the reflex to take that mark back arrives. With something typed in it, ⌘Z
  // is the typing's again.
  const emptyField = target instanceof HTMLInputElement && target.value === '';
  const fieldKey = key === 'escape'
    || ((event.metaKey || event.ctrlKey)
        && ((key === 'z' && !emptyField) || (!event.shiftKey && ['a', 'c', 'v', 'x'].includes(key))));
  if (typing && fieldKey) return;
  if (key === 'escape') {
    // Escape backs out one level: the crop, then the selection, then the editor.
    event.preventDefault();
    if (layer.pendingCrop) layer.clearCrop();
    else if (!layer.deselect()) void dismiss().catch(report);
  } else if (event.metaKey && key === 'q') {
    // No menu bar on an accessory app, so nothing else would catch this.
    event.preventDefault(); void command('quit_app').catch(report);
  } else if ((event.metaKey || event.ctrlKey) && key === 'w') {
    event.preventDefault(); void dismiss().catch(report);
  } else if (isTauri && event.metaKey && key === ',') {
    event.preventDefault(); void command('open_settings').catch(report);
  } else if (capture && (event.metaKey || event.ctrlKey) && key === 'a') {
    event.preventDefault();
    if (!layer.selectAll()) flash('Nothing drawn to select.');
  } else if (capture && (event.metaKey || event.ctrlKey) && (key === ']' || key === '}')) {
    event.preventDefault();
    if (!layer.reorder(event.shiftKey ? 'front' : 'forward')) flash('Select something to reorder.');
  } else if (capture && (event.metaKey || event.ctrlKey) && (key === '[' || key === '{')) {
    event.preventDefault();
    if (!layer.reorder(event.shiftKey ? 'back' : 'backward')) flash('Select something to reorder.');
  } else if (capture && (event.metaKey || event.ctrlKey) && (key === '=' || key === '+')) {
    event.preventDefault(); stepZoom(1);
  } else if (capture && (event.metaKey || event.ctrlKey) && key === '-') {
    event.preventDefault(); stepZoom(-1);
  } else if (capture && (event.metaKey || event.ctrlKey) && key === '0') {
    event.preventDefault(); setZoom('fit');
  } else if (capture && (event.metaKey || event.ctrlKey) && key === '1') {
    event.preventDefault(); setZoom(1);
  } else if (capture && (event.metaKey || event.ctrlKey) && key === 'z') {
    event.preventDefault(); stepBack();
  } else if (capture && !typing && (key === 'backspace' || key === 'delete')) {
    event.preventDefault(); layer.deleteSelected();
  } else if (capture && key === 'l' && event.shiftKey && (event.metaKey || event.ctrlKey)) {
    event.preventDefault(); void copyList();
  } else if (capture && key === 's' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault(); void exportImage(event.shiftKey ? 'share_image' : 'save_image');
  } else if (capture && key === 'c' && event.shiftKey && (event.metaKey || event.ctrlKey)) {
    event.preventDefault(); void copyCapture(false);
  } else if (capture && key === 'c' && (event.metaKey || event.ctrlKey)) {
    // The footer button reads "Copy and Close ⌘C", so ⌘C copies and closes,
    // whatever happens to be selected. It used to take the selection instead
    // whenever there was one -- which is to say from the instant you drew
    // anything, because a fresh mark arrives selected. The button was wrong
    // exactly when it was most likely to be read. Duplicating a mark is ⌘D.
    event.preventDefault();
    if (layer.pendingCrop) { flash('Finish or cancel the crop first.'); return; }
    void copyCapture(true);
  } else if (capture && key === 'v' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    if (!layer.paste().length) flash('Select a mark and duplicate it with ⌘D first.');
  } else if (capture && key === 'd' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    if (!layer.duplicateSelection().length) flash('Select something to duplicate.');
  } else if (capture && key === 'enter' && layer.pendingCrop) {
    // The crop bar says "Crop ⏎", so here Return does what it is offered for.
    event.preventDefault(); void applyCrop().catch(report);
  }
  // Return does nothing else. macOS would have it fire the default button, and
  // it used to, which meant a stray Return copied and closed the capture --
  // surprising in an editor you type in, and a real loss when the thing it
  // closed took work. Copying has ⌘C and ⌘⇧C, and Return on the Copy button
  // itself still presses it, because that is what a focused button does.
}, { signal: abort.signal });

/** Everywhere the editor shows the capture shortcut. The setting is the truth;
 *  the markup only starts out with the default so the browser preview has one. */
function showShortcut(shortcut: string) {
  const pretty = prettyShortcut(shortcut);
  for (const key of app.querySelectorAll<HTMLElement>('.start kbd, .capture-menu [data-mode="region"] kbd')) key.textContent = pretty;
}

async function init() {
  if (isTauri) {
    app.querySelector<HTMLElement>('.quit-hint')!.hidden = false;
    const gear = app.querySelector<HTMLButtonElement>('.settings-button')!;
    gear.hidden = false;
    on(gear, 'click', () => { void command('open_settings').catch(report); });
    void command<{ shortcut: string }>('get_settings').then(s => showShortcut(s.shortcut)).catch(() => {});
    cleanups.push(await watchSettings(s => showShortcut(s.shortcut)));
    // On macOS 26 the panes sit on the system's own glass, laid under the web
    // view by lib.rs, so the stylesheet draws them bare there.
    document.documentElement.classList.toggle('native-glass', await command<boolean>('glass_available').catch(() => false));
    const unlisten = await watchCapture(() => { void refresh(); });
    if (disposed) { unlisten(); return; }
    cleanups.push(unlisten); await refresh();
  } else {
    document.documentElement.classList.add('browser');
    app.querySelector<HTMLElement>('.preview-label')!.hidden = false;
    choose.hidden = false;
    capture = sampleCapture(); render();
  }
}
render();
void init().catch(report);
import.meta.hot?.dispose(() => { disposed = true; abort.abort(); cleanups.forEach(cleanup => cleanup()); });
