import './style.css';
import { command, isTauri, videoSource, watchCapture, watchCopied, watchMenuCopy, watchRequestWithdrawn, watchSettings, type Asked,
         type CapturePreview, type SavedSettings, type Snapshot } from './platform';
import { clock, everything, moveEdge, playFrom, whole, type Trim } from './trim';
import { MAX_BASE64, describeMarks, resultText, sendSize } from './send';
import { suggestedName } from './names';
import { ago } from './ago';
import { DEFAULT_SHORTCUT, prettyShortcut } from './shortcut';
// The icon as an import, so its path is right whether this page is the app's
// own or the copy the web demo runs in a frame.
import markIcon from './mark-icon.png';
import { copyThenDismiss } from './model';
import { readingOrder, within, type Area, type TextLine } from './text';
import { describeHidden, findSensitive } from './sensitive';
import { BACKGROUNDS, BAR_COLOURS, DEFAULT_FRAME, LIGHTS_SVG, backgroundOf, cssBackground, darkTop, frameGeometry, paintFrame,
         sanitizeFrame, type FrameStyle } from './frame';
import { sampleCapture } from './sample';
import { ARROW_STYLES, AnnotationLayer, COLORS, LOOKS, hexColour, NOTE_MODES, SHAPE_FILLS, arrowPolygon, arrowStrokes, arrowStrokeWidth,
         FONT, arrowPaint, badgeAt, blockSize, describe, drawAnnotations, fillOf, fillable, hasLook, inkOn, isShape, numbered,
         outsetOps, pathData, polygonPath, stepArrow, stepList, strokePath, styleOf, takesLooks, textSize,
         type Annotation, type ArrowStyle, type Look, type NoteMode, type Point, type Shape, type ShapeFill, type Tool } from './annotations';

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
 *  is an undo for closing, not a library. A recording keeps its trim. */
interface Past { id: number; capture: CapturePreview; thumb: string; annotations: Annotation[]; at: number; trim?: Trim }
const KEPT = 6;
/** How many of them Recent's strip shows side by side; the rest scroll. */
const STRIP = 4;
/** Roughly 90 MB of image once decoded from base64. */
const KEPT_CHARS = 120_000_000;

/** Six tools do not fit as words, so the palette is glyphs with real labels
 *  behind them for screen readers and tooltips. */
const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
/** The ways into a capture. Part of the screen, one window, all of it, and
 *  part of it later: a frame, a window, a filled display, and a stopwatch, so
 *  the set reads as four answers to the same question rather than four
 *  unrelated pictures. And a fifth that is a different kind of thing, a
 *  recording, on a row of its own. */
type CaptureMode = 'region' | 'window' | 'display' | 'timed' | 'record';
/** `tile` is the word on the empty state's tiles and `does` the few words
 *  under it, short enough for two to a row in the smallest window; `tip` says
 *  it in full where there is room, in the Capture menu. */
const CAPTURE_MODES: { mode: CaptureMode; name: string; tile: string; does: string; tip: string; hint: string; art: string }[] = [
  { mode: 'region', name: 'Region', tile: 'Region', does: 'Drag out part of the screen', tip: 'Drag out the part of the screen to capture', hint: prettyShortcut(DEFAULT_SHORTCUT), art:
    `<path d="M4.4 7.7V5.9a1.5 1.5 0 0 1 1.5-1.5h1.8M12.3 4.4h1.8a1.5 1.5 0 0 1 1.5 1.5v1.8`
    + `M15.6 12.3v1.8a1.5 1.5 0 0 1-1.5 1.5h-1.8M7.7 15.6H5.9a1.5 1.5 0 0 1-1.5-1.5v-1.8" ${STROKE}/>` },
  { mode: 'window', name: 'Window', tile: 'Window', does: 'Click one, even if it’s covered', tip: 'Click a window to capture it, whole even where it is covered', hint: '', art:
    `<rect x="3.2" y="4.4" width="13.6" height="11.2" rx="1.8" ${STROKE}/>`
    + `<path d="M3.2 7.8h13.6" ${STROKE}/>`
    + `<circle cx="5.6" cy="6.1" r=".7" fill="currentColor"/><circle cx="7.6" cy="6.1" r=".7" fill="currentColor"/>` },
  { mode: 'display', name: 'Whole Screen', tile: 'Screen', does: 'The whole display, right away', tip: 'Capture the whole screen the pointer is on, straight away', hint: '', art:
    `<rect x="3.2" y="4.5" width="13.6" height="9.6" rx="1.8" fill="currentColor" opacity=".16"/>`
    + `<rect x="3.2" y="4.5" width="13.6" height="9.6" rx="1.8" ${STROKE}/>`
    + `<path d="M7.6 16.6h4.8" ${STROKE}/>` },
  { mode: 'timed', name: 'Timed Region', tile: 'Timed', does: 'A region, five seconds later', tip: 'Choose a region, then capture it five seconds later', hint: '5s', art:
    `<circle cx="10" cy="11.4" r="5.4" ${STROKE}/>`
    + `<path d="M10 8.4v3l2.1 1.3M8.1 3.4h3.8M10 3.4v2.6" ${STROKE}/>` },
  { mode: 'record', name: 'Record Video', tile: 'Record', does: 'A short video of part of the screen, a window or all of it', tip: 'Record part of the screen, a window or all of it', hint: '', art:
    `<circle cx="10" cy="10" r="6.4" ${STROKE}/>`
    + `<circle class="record-dot" cx="10" cy="10" r="3.2" fill="currentColor"/>` },
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
/** Each way of drawing also answers to a key, as tools do in every drawing app:
 *  its first letter where that is free. Ways that share a slot can share a key,
 *  which then steps through them -- A for an arrow, A again for a numbered one. */
interface Choice { id: Tool; numbered?: boolean; name: string; key: string; art: string }
const SLOTS: Choice[][] = [
  [
    { id: 'arrow', name: 'Arrow', key: 'a', art: `<path d="M5.5 14.5 14 6M5.5 14.5h5.2M5.5 14.5V9.3" ${STROKE}/>` },
    { id: 'arrow', numbered: true, name: 'Numbered arrow', key: 'a', art:
      `<path d="M9.4 11.2 15 5.6M15 5.6h-3.6M15 5.6v3.6" ${STROKE}/>` + BADGE(6.4, 13.6, 4.3) },
  ],
  [
    { id: 'line', name: 'Line', key: 'l', art: `<path d="M5.4 14.6 14.6 5.4" ${STROKE}/>` },
    { id: 'measure', name: 'Measure', key: 'm', art: `<path d="M4.2 11.4h11.6M4.2 8v6.8M15.8 8v6.8" ${STROKE}/>` },
  ],
  [{ id: 'pen', name: 'Pen', key: 'p', art:
    `<path d="M4.2 13.8c1.9-4.6 3.2 2.3 5.1-1.1s2.9 3 4.4-1.2 1.4 2 2.1.9" ${STROKE}/>` }],
  [{ id: 'text', name: 'Text', key: 't', art: `<path d="M5 6h10M10 6v8.5M7.8 14.5h4.4" ${STROKE}/>` }],
  [
    { id: 'box', name: 'Box', key: 'b', art: `<rect x="4.6" y="5.8" width="10.8" height="8.4" rx="1.4" ${STROKE}/>` },
    { id: 'box', numbered: true, name: 'Numbered box', key: 'b', art:
      `<rect x="6.4" y="7.4" width="9" height="7.4" rx="1.4" ${STROKE}/>` + BADGE(5.6, 6.2, 4.1) },
  ],
  [
    { id: 'ellipse', name: 'Ellipse', key: 'o', art: `<ellipse cx="10" cy="10" rx="5.6" ry="4.4" ${STROKE}/>` },
    { id: 'ellipse', numbered: true, name: 'Numbered ellipse', key: 'o', art:
      `<ellipse cx="11" cy="11.2" rx="4.6" ry="3.7" ${STROKE}/>` + BADGE(5.6, 6.2, 4.1) },
  ],
  [{ id: 'highlight', name: 'Highlighter', key: 'h', art:
    `<path d="M4.6 15.6h10.8" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" opacity=".45"/>` +
    `<path d="M6.9 12.4 12.4 6.9l2 2-5.5 5.5z" ${STROKE}/>` }],
  [{ id: 'redact', name: 'Redact', key: 'x', art:
    `<path d="M4.8 5.2h4.1v4.1H4.8zM11.1 5.2h4.1v4.1h-4.1zM4.8 10.7h4.1v4.1H4.8zM11.1 10.7h4.1v4.1h-4.1z" fill="currentColor"/>` }],
  [{ id: 'crop', name: 'Crop', key: 'c', art:
    `<path d="M6.6 2.8v10.6h10.6M2.8 6.6h10.6v10.6" ${STROKE}/>` }],
];
/** A tool's tooltip names its key, as "Undo (⌘Z)" names its own. */
const tipOf = (choice: Choice) => `${choice.name} (${choice.key.toUpperCase()})`;
/** Which variant each slot is wearing. */
const worn = SLOTS.map(() => 0);
/** What a crop can be held to: free, the image's own shape, or the shapes a
 *  screenshot is most often wanted in -- square, the classic screen, wide, and
 *  tall for a phone. */
const CROP_SHAPES: { id: string; name: string; ratio: number | null }[] = [
  { id: 'free', name: 'Free', ratio: null }, { id: 'original', name: 'Original', ratio: null },
  { id: '1:1', name: '1:1', ratio: 1 }, { id: '4:3', name: '4:3', ratio: 4 / 3 },
  { id: '16:9', name: '16:9', ratio: 16 / 9 }, { id: '9:16', name: '9:16', ratio: 9 / 16 },
];
const slotButton = (slot: Choice[], index: number) => {
  const choice = slot[worn[index]];
  // No tooltip on a slot with a menu: resting on it opens the menu, which names
  // every way it has including the one it is wearing.
  return `<button class="tool" type="button" role="radio" data-slot="${index}" aria-checked="${index === 0}"
        ${slot.length > 1 ? 'aria-haspopup="menu" aria-expanded="false"' : `title="${tipOf(choice)}"`}>`
    + `<svg viewBox="0 0 20 20" aria-hidden="true">${choice.art}</svg>`
    + (slot.length > 1 ? '<span class="tool-more" aria-hidden="true"></span>' : '')
    + `<span class="sr">${choice.name}</span></button>`;
};

/** What the empty state says under its heading: this, or, while an AI tool
 *  waits on a screenshot, what to do about that. */
const RESTING_HINT = 'A little less between seeing and sharing.';
const ASKED_HINT = 'Bring it on screen, then capture it.';

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
          <span>${item.name}</span><kbd>${item.hint}</kbd>
        </button>`).join('')}
      </div>
    </div>
  </header>
  <div class="toolbar" role="toolbar" aria-label="Annotation tools" hidden>
    <div class="swatches" role="radiogroup" aria-label="Color">
      ${COLORS.map(color => `<button class="swatch" type="button" role="radio" aria-checked="false"
        data-color="${color.value}" style="--swatch:${color.value}" title="${color.name}"><span class="sr">${color.name}</span></button>`).join('')}
      <div class="custom-colour">
        <button class="swatch custom" type="button" role="radio" aria-checked="false" aria-haspopup="dialog"
          aria-expanded="false" title="Any colour"><span class="sr">Any colour</span></button>
        <div class="colour-menu" role="dialog" aria-label="Any colour" hidden>
          <div class="colour-row">
            <input class="hex" type="text" maxlength="7" spellcheck="false" autocomplete="off"
              aria-label="Hex colour" placeholder="#FF3B30" />
            <button class="pick" type="button" aria-label="Take a colour from the image" title="Take a colour from the image">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.9 3.8a2 2 0 0 1 2.8 2.8l-1.5 1.5.9.9-1.3 1.3-4.1-4.1 1.3-1.3.9.9zM10.4 7.6l-5.8 5.8v2.4H7l5.8-5.8" ${STROKE}/></svg>
            </button>
          </div>
          <div class="recent-colours" role="group" aria-label="Recent colours"></div>
        </div>
      </div>
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
    <button class="hide-sensitive glassy" type="button" hidden
      title="Find and pixelate email addresses, phone and card numbers, keys and faces (⇧⌘R)">
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.8 10s2.6-4.9 7.2-4.9 7.2 4.9 7.2 4.9-2.6 4.9-7.2 4.9S2.8 10 2.8 10z"/><circle cx="10" cy="10" r="2.1"/><path d="M4 16 16 4"/></svg>
      <span class="hide-word">Hide Sensitive</span>
    </button>
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
  <!-- An AI tool's ask, for as long as it waits: across the top of the canvas,
       clear of the rail, in the empty state as over a capture. -->
  <aside class="request-bar" aria-label="Request for a screenshot" hidden>
    <svg class="request-glyph" viewBox="0 0 20 20" aria-hidden="true"><path d="M4.4 4.2h11.2a1.6 1.6 0 0 1 1.6 1.6v6.6a1.6 1.6 0 0 1-1.6 1.6H9.4l-3.6 2.9v-2.9H4.4a1.6 1.6 0 0 1-1.6-1.6V5.8a1.6 1.6 0 0 1 1.6-1.6z" ${STROKE}/><path d="M6.8 9.1h6.4" ${STROKE}/></svg>
    <p class="request-text"><strong class="request-client"></strong> asks to see <span class="request-prompt"></span></p>
    <span class="request-wait" hidden title="Most AI tools stop waiting after a minute. Claude Code waits as long as you need."></span>
    <button class="request-decline glassy" type="button">Don’t Send</button>
  </aside>
  <div class="workspace">
    <nav class="rail" aria-label="Tools" hidden>
      <div class="tools" role="radiogroup" aria-label="Tool">
        <div class="tool-group">${SLOTS.slice(0, -1).map(slotButton).join('')}</div>
        <div class="tool-group">${SLOTS.slice(-1).map((slot, i) => slotButton(slot, SLOTS.length - 1 + i)).join('')}</div>
      </div>
      <div class="tool-menu" role="menu" hidden></div>
    </nav>
  <main class="canvas" aria-label="Screenshot editor">
    <div class="backdrop"><div class="card">
      <div class="chrome" aria-hidden="true" hidden></div>
      <div class="stage" hidden>
        <img class="capture" alt="Captured screenshot" draggable="false" />
        <video class="movie" playsinline preload="auto" hidden></video>
        <svg class="overlay" xmlns="http://www.w3.org/2000/svg" role="group" aria-label="Arrow annotations"></svg>
      </div>
    </div></div>
    <section class="empty" hidden>
      <!-- The icon itself, so what greets you on launch is exactly what sits in
           the Dock. It used to be redrawn from paths, which is how the two came
           to be different pictures. -->
      <div class="empty-head">
        <img class="viewfinder" src="${markIcon}" alt="" width="46" height="46" />
        <div><h1>Capture your screen</h1><p class="empty-hint">${RESTING_HINT}</p></div>
      </div>
      <!-- Every way in at once, rather than one button with the rest behind a
           menu: large tiles that each say what they do, so Window's "even if
           it's covered" needs no tooltip to be found. A region, the one most
           reached for, is the blue one. -->
      <div class="modes" role="group" aria-label="Capture">
        ${CAPTURE_MODES.map(item => `<button class="mode ${item.mode === 'region' ? 'start primary' : 'glassy'}" type="button"
          data-start="${item.mode}"><span class="mode-icon"><svg viewBox="0 0 20 20" aria-hidden="true">${item.art}</svg></span>
          <span class="mode-text"><span class="mode-name">${item.tile}</span><span class="mode-does">${item.does}</span></span><kbd class="mode-hint">${item.hint}</kbd></button>`).join('')}
      </div>
      <section class="recents" hidden aria-label="Recent captures">
        <div class="recents-head"><p class="recents-label">Recent</p><span class="recents-count"></span></div>
        <div class="recent-list"></div>
      </section>
      <p class="quit-hint" hidden>Mark lives in the menu bar · ⌘, settings · ⌘W hides it · ⌘Q quits</p>
    </section>
  </main>
  </div>
  <!-- A recording's player and trim: play, and the part to keep, between two
       handles over a strip of its frames. Its height is STRIP in recording.rs. -->
  <div class="trim" hidden>
    <button class="play glassy icon" type="button" aria-label="Play" title="Play (Space)">
      <svg class="when-paused" viewBox="0 0 20 20" aria-hidden="true"><path d="M6.6 4.6v10.8L15.4 10z" fill="currentColor"/></svg>
      <svg class="when-playing" viewBox="0 0 20 20" aria-hidden="true" hidden><path d="M6 4.6h2.8v10.8H6zM11.2 4.6H14v10.8h-2.8z" fill="currentColor"/></svg>
    </button>
    <div class="strip">
      <div class="frames"></div>
      <div class="kept"></div>
      <div class="playhead"></div>
      <span class="mark-at" hidden title="When the selected mark appears: drag to change it"></span>
      <span class="edge" data-edge="start" role="slider" tabindex="0" aria-label="Start of the part to keep" title="Drag to trim the start (I)"></span>
      <span class="edge" data-edge="end" role="slider" tabindex="0" aria-label="End of the part to keep" title="Drag to trim the end (O)"></span>
    </div>
    <span class="trim-time"></span>
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
    <div class="segments crop-shapes" role="radiogroup" aria-label="Crop shape">
      ${CROP_SHAPES.map((shape, index) => `<button class="segment" type="button" role="radio"
        aria-checked="${index === 0}" data-shape="${shape.id}">${shape.name}</button>`).join('')}
    </div>
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
    <button class="frame-button glassy icon" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="Frame"
      title="Frame: a background, room and rounded corners around the image">
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.6" y="3.2" width="14.8" height="13.6" rx="3.4"/><rect x="6.2" y="6.8" width="7.6" height="6.4" rx="1.3" fill="currentColor" fill-opacity=".28"/></svg>
    </button>
    <span class="exports">
    <button class="share glassy icon" type="button" title="Share (⌘⇧S)" aria-label="Share">
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.8v9M6.8 6l3.2-3.2L13.2 6"/><path d="M5 10.6H4.2a1.4 1.4 0 0 0-1.4 1.4v4.2a1.4 1.4 0 0 0 1.4 1.4h11.6a1.4 1.4 0 0 0 1.4-1.4V12a1.4 1.4 0 0 0-1.4-1.4H15"/></svg>
    </button>
    <button class="save glassy icon" type="button" title="Save to a file (⌘S)" aria-label="Save to a file">
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.8v9M6.8 8.6 10 11.8l3.2-3.2"/><path d="M3.4 14v2.2a1.4 1.4 0 0 0 1.4 1.4h10.4a1.4 1.4 0 0 0 1.4-1.4V14"/></svg>
      <span class="save-word" hidden>Save Video</span>
    </button>
    <button class="save-more glassy icon" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Other ways to save" title="Other ways to save" hidden>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.4 8.4 10 12l3.6-3.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <button class="copy-text glassy icon" type="button" aria-label="Copy text"
      title="Copy the text in the image, or in the selected box (⇧⌘T)">
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.6V4.8A1.8 1.8 0 0 1 4.8 3h1.8M13.4 3h1.8A1.8 1.8 0 0 1 17 4.8v1.8M17 13.4v1.8a1.8 1.8 0 0 1-1.8 1.8h-1.8M6.6 17H4.8A1.8 1.8 0 0 1 3 15.2v-1.8"/><path d="M6.8 7.6h6.4M6.8 10.2h6.4M6.8 12.8h3.8"/></svg>
    </button>
    </span>
    <button class="steps-toggle glassy" type="button" hidden aria-expanded="false"
      title="What each number means (⌘⇧L copies the list)">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <mask id="steps-toggle-glyph"><circle cx="10" cy="10" r="7.2" fill="#fff"/><path d="M8.4 8.4 10.4 6.8v6.4M8.6 13.2h3.6" fill="none" stroke="#000" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></mask>
        <circle cx="10" cy="10" r="7.2" fill="currentColor" mask="url(#steps-toggle-glyph)"/>
      </svg><span class="steps-word">Steps</span> <span class="steps-count"></span>
    </button>
    <button class="close-capture glassy icon" type="button" title="Close without copying (⌘W)" aria-label="Close without copying">
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6 6l8 8M14 6l-8 8"/></svg>
    </button>
    <button class="copy-only glassy" type="button" title="Copy the image and keep working">Copy <kbd>⌘C</kbd></button>
    <button class="copy primary" type="button"><span class="copy-label">Copy and Close</span> <kbd>⌥⌘C</kbd></button>
  </footer>
  <!-- A recording saves as a movie; this is the other way, a GIF that loops. -->
  <div class="save-menu" role="menu" aria-label="Save" hidden>
    <button type="button" role="menuitem" data-save="save"><span>Save Video</span><kbd>⌘S</kbd></button>
    <button type="button" role="menuitem" data-save="gif"><span>Save as GIF</span><kbd>⌥⌘S</kbd></button>
  </div>
  <aside class="frame-panel" role="dialog" aria-label="Frame" hidden>
    <div class="frame-head">
      <span class="frame-title">Frame</span>
      <button class="frame-switch" type="button" role="switch" aria-checked="false" aria-label="Frame the image"></button>
    </div>
    <div class="backgrounds" role="radiogroup" aria-label="Background">
      ${BACKGROUNDS.map(background => `<button class="background" type="button" role="radio" aria-checked="false"
        data-background="${background.id}" title="${background.name}" aria-label="${background.name}"
        style="--background: ${cssBackground(background)}"></button>`).join('')}
    </div>
    ${([['padding', 'Padding'], ['radius', 'Corners'], ['shadow', 'Shadow']] as const).map(([key, name]) =>
      `<label class="frame-slider"><span>${name}</span><input type="range" min="0" max="1" step="0.01" data-frame="${key}" /></label>`).join('')}
    <label class="frame-check"><input type="checkbox" data-frame="chrome" /><span>Title bar</span></label>
  </aside>
  <input class="file-input" type="file" accept="image/png,image/jpeg,image/webp" hidden />
`;
const image = app.querySelector<HTMLImageElement>('.capture')!;
const stage = app.querySelector<HTMLElement>('.stage')!;
const backdrop = app.querySelector<HTMLElement>('.backdrop')!;
const card = app.querySelector<HTMLElement>('.card')!;
const chrome = app.querySelector<HTMLElement>('.chrome')!;
const frameButton = app.querySelector<HTMLButtonElement>('.frame-button')!;
const framePanel = app.querySelector<HTMLElement>('.frame-panel')!;
const frameSwitch = framePanel.querySelector<HTMLButtonElement>('.frame-switch')!;
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
const customSwatch = app.querySelector<HTMLButtonElement>('.swatch.custom')!;
const colourMenu = app.querySelector<HTMLElement>('.colour-menu')!;
const hexField = colourMenu.querySelector<HTMLInputElement>('.hex')!;
const recentColours = colourMenu.querySelector<HTMLElement>('.recent-colours')!;
/** This session's own colours, newest first: the eight are always there. */
const customColours: string[] = [];
const noteModes = app.querySelector<HTMLElement>('.steps-show .segments')!;
const fills = app.querySelector<HTMLElement>('.fills')!;
const removeButton = app.querySelector<HTMLButtonElement>('.remove')!;
const hideButton = app.querySelector<HTMLButtonElement>('.hide-sensitive')!;
const empty = app.querySelector<HTMLElement>('.empty')!;
const emptyHint = app.querySelector<HTMLElement>('.empty-hint')!;
const copy = app.querySelector<HTMLButtonElement>('.copy')!;
const copyLabel = copy.querySelector<HTMLElement>('.copy-label')!;
const requestBar = app.querySelector<HTMLElement>('.request-bar')!;
const requestText = requestBar.querySelector<HTMLElement>('.request-text')!;
const requestWait = requestBar.querySelector<HTMLElement>('.request-wait')!;
const copyOnly = app.querySelector<HTMLButtonElement>('.copy-only')!;
const closeButton = app.querySelector<HTMLButtonElement>('.close-capture')!;
const shareButton = app.querySelector<HTMLButtonElement>('.share')!;
const saveButton = app.querySelector<HTMLButtonElement>('.save')!;
const copyTextButton = app.querySelector<HTMLButtonElement>('.copy-text')!;
const saveMore = app.querySelector<HTMLButtonElement>('.save-more')!;
const saveMenu = app.querySelector<HTMLElement>('.save-menu')!;
const saveWord = saveButton.querySelector<HTMLElement>('.save-word')!;
const movie = app.querySelector<HTMLVideoElement>('.movie')!;
const trimBar = app.querySelector<HTMLElement>('.trim')!;
const playButton = trimBar.querySelector<HTMLButtonElement>('.play')!;
const strip = trimBar.querySelector<HTMLElement>('.strip')!;
const stripFrames = strip.querySelector<HTMLElement>('.frames')!;
const kept = strip.querySelector<HTMLElement>('.kept')!;
const playhead = strip.querySelector<HTMLElement>('.playhead')!;
const trimTime = trimBar.querySelector<HTMLElement>('.trim-time')!;
const markAt = strip.querySelector<HTMLElement>('.mark-at')!;
/** The crop tool's own group at the foot of the rail. */
const cropGroup = rail.querySelectorAll<HTMLElement>('.tool-group')[1];
const start = app.querySelector<HTMLButtonElement>('.start')!;
const modeTiles = [...app.querySelectorAll<HTMLButtonElement>('.mode')];
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
const recentsCount = app.querySelector<HTMLElement>('.recents-count')!;
const cropSize = app.querySelector<HTMLElement>('.crop-size')!;
const cropShapes = app.querySelector<HTMLElement>('.crop-shapes')!;
const cropApply = app.querySelector<HTMLButtonElement>('.crop-apply')!;
const abort = new AbortController();
const cleanups: (() => void)[] = [];
let capture: CapturePreview | null = null;
/** The part of the recording open, if one is, that Copy, Save and Share take. */
let trim: Trim | null = null;
/** Whether this Mac can record, which Rust says once: macOS 15 or later. */
let recordable = false;
/** An AI tool's ask, while one waits for a screenshot. */
let request: Asked | null = null;
/** How a capture is framed: kept by Rust in the app, for the session in the preview. */
let frame: FrameStyle = { ...DEFAULT_FRAME };
/** Whether the current capture's top edge is dark, so its title bar would be. */
let barDark = false;
let busy = false;
let copyPending = false;
let disposed = false;
let shown: CapturePreview | null = null;
/** When the capture in the editor was taken -- or, for one reopened from
 *  Recent, when it first was. */
let shownAt = 0;
/** What the empty state says under its heading when nothing is asked of it. */
let restingHint = RESTING_HINT;
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

/** Set while a flashed message is up, which a refresh with nothing to report
 *  leaves alone: what an AI tool's ask ending says arrives with the refresh
 *  that ending set off, and must outlast it. */
let flashTimer: ReturnType<typeof setTimeout> | undefined;
function flash(text: string) {
  showMessage(text);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashTimer = undefined; if (!disposed) showMessage(null); }, 1800);
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
  const outer = app.getBoundingClientRect(), canvas = canvasArea.getBoundingClientRect();
  return { left: canvas.left - outer.left, top: canvas.top - outer.top,
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

/** Said after a copy that held the selection too, so ⌘V's half of it is no secret. */
function heldHint(held: readonly Annotation[]): string {
  if (!held.length) return '';
  return ` ⌘V pastes the ${held.length === 1 ? describe(held[0].kind).toLowerCase() : `${held.length} marks`}.`;
}

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
  // With Redact in hand, the one that finds what to redact by itself.
  hideButton.hidden = layer.tool !== 'redact' || !!capture?.video;
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
    // A corner can take text past either end of the slider; the next mark
    // goes by what the slider can show rather than that size.
    layer.style.scale = Math.min(Number(weight.max), Math.max(Number(weight.min), selected.kind === 'text'
      ? selected.size / textSize(layer.base)
      : selected.weight / layer.base));
  }
  weight.value = layer.style.scale.toFixed(2);
  syncSteps();
  for (const swatch of app.querySelectorAll<HTMLButtonElement>('.swatch')) {
    const active = swatch.dataset.color === layer.style.color;
    swatch.setAttribute('aria-checked', String(active));
    swatch.classList.toggle('active', active);
  }
  // A colour that is none of the eight shows on the ninth, which is then the
  // one checked: there is always a swatch saying what the next mark will be.
  const offPalette = !COLORS.some(color => color.value === layer.style.color);
  customSwatch.setAttribute('aria-checked', String(offPalette));
  customSwatch.classList.toggle('active', offPalette);
  customSwatch.style.setProperty('--swatch', offPalette ? layer.style.color : '');
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
  // With the crop tool in hand the bar is there before anything is dragged,
  // so the shape can be chosen first.
  cropBar.hidden = !crop && layer.tool !== 'crop';
  cropSize.textContent = crop ? `Crop to ${Math.round(crop.width)} × ${Math.round(crop.height)} px` : 'Drag to crop';
  cropApply.disabled = !crop;
  if (!cropBar.hidden) placeLens(cropShapes);
  undoButton.disabled = !layer.canUndo && !crops.length;
  removeButton.disabled = picked.length === 0 || layer.isEditing;
  backButton.disabled = frontButton.disabled = picked.length === 0 || layer.isEditing;
  for (const group of [tools, styles, fills]) placeLens(group);
  // On a recording, the strip says when the mark selected appears.
  if (capture?.video) drawTrim();
}

function render() {
  const video = capture?.video ?? null;
  // The glass is under the toolbar and the rail -- and the crop tool, which a
  // recording goes without.
  if (isTauri) void command('set_glass', { visible: !!capture, crop: !video }).catch(() => {});
  stage.hidden = !capture;
  toolbar.hidden = !capture;
  rail.hidden = !capture;
  cropGroup.hidden = !!video;
  if (video && layer.tool === 'crop') wear(0, worn[0]);
  trimBar.hidden = !video;
  app.classList.toggle('video', !!video);
  empty.hidden = !!capture;
  if (capture) {
    // A different capture means a different drawing surface. A crop swaps the
    // image in place and updates `shown` itself, so it is not mistaken for one.
    if (capture !== shown) {
      if (shown) remember(shown);
      image.src = capture.dataUrl;
      stage.style.setProperty('--ratio', `${capture.width} / ${capture.height}`);
      layer.density = capture.scale ?? 1;
      layer.setImage(capture.width, capture.height);
      shown = capture; shownAt = Date.now(); mustFlatten = false; crops.length = 0; zoom = startingZoom(capture);
      showMovie(capture);
      // A different capture is a differently sized window, so a position chosen
      // for the last one means nothing here.
      delete stepsPanel.dataset.moved;
      stepsPanel.style.left = ''; stepsPanel.style.top = ''; stepsPanel.style.bottom = '';
    }
    image.alt = video ? `First frame of a recording, ${capture.width} by ${capture.height} pixels`
      : `Captured screenshot, ${capture.width} by ${capture.height} pixels`;
  } else {
    // The capture is on its way out, so keep it before the layer is reset.
    if (shown) { remember(shown); shown = null; mustFlatten = false; crops.length = 0; }
    image.removeAttribute('src');
    showMovie(null);
  }
  drawRecents();
  // Framed, the size is the size of what will be copied.
  const framedSize = capture && frame.on ? frameGeometry(capture.width, capture.height, capture.scale ?? 1, frame) : null;
  app.querySelector('.dimensions')!.textContent = !capture ? ''
    : video ? `${capture.width} × ${capture.height} px · ${clock(video.duration)}`
    : framedSize ? `${framedSize.width} × ${framedSize.height} px, framed` : `${capture.width} × ${capture.height} px`;
  if (!capture) closeFramePanel();
  // With nothing captured every control in the footer is hidden, which left an
  // empty band of chrome across the bottom of the empty state.
  app.querySelector<HTMLElement>('footer')!.hidden = !capture;
  copy.hidden = !capture;
  copyOnly.hidden = closeButton.hidden = !capture;
  shareButton.hidden = saveButton.hidden = !capture || !isTauri;
  app.querySelector<HTMLElement>('.exports')!.hidden = !capture || !isTauri;
  shareButton.disabled = saveButton.disabled = copyTextButton.disabled = saveMore.disabled = busy || copyPending;
  // A recording is not framed or read. It saves as a movie, said in words
  // so it is plainly the way it saves, and as a GIF from the menu beside it.
  copyTextButton.hidden = !!video;
  saveMore.hidden = !video || !isTauri;
  saveWord.hidden = !video;
  saveButton.classList.toggle('icon', !video);
  saveButton.dataset.tip = video ? 'Save the video, as an MP4 (⌘S)' : 'Save to a file (⌘S)';
  saveButton.setAttribute('aria-label', video ? 'Save Video' : 'Save to a file');
  if (!video) closeSaveMenu();
  frameButton.hidden = !!video;
  copyOnly.dataset.tip = video ? 'Copy the recording and keep working' : 'Copy the image and keep working';
  zoomSelect.parentElement!.hidden = !capture || !!video;
  applyZoom();
  copy.disabled = busy || copyPending;
  copyOnly.disabled = closeButton.disabled = busy || copyPending;
  // The preview has no screen to capture, so it has one way in: a file.
  // Recording needs macOS 15, and waits while an AI tool waits for a screenshot.
  const canRecord = isTauri && recordable && !request;
  for (const tile of modeTiles) {
    tile.disabled = busy;
    if (tile !== start) tile.hidden = !isTauri || (tile.dataset.start === 'record' && !canRecord);
  }
  captureMenu.querySelector<HTMLElement>('[data-mode="record"]')!.hidden = !canRecord;
  start.querySelector('.mode-name')!.textContent = isTauri ? (busy ? 'Selecting…' : 'Region') : 'Choose image…';
  start.querySelector('kbd')!.hidden = !isTauri;
  // An AI tool's ask, while it waits: the bar says who asked and for what --
  // as text, whatever the tool sent -- the way in it named is the one offered
  // first, and the primary button sends rather than copies.
  app.classList.toggle('requesting', !!request);
  app.classList.toggle('at-rest', !capture);
  requestBar.hidden = !request;
  if (request) {
    requestBar.querySelector('.request-client')!.textContent = request.client;
    requestBar.querySelector('.request-prompt')!.textContent = `“${request.prompt}”`;
    requestText.dataset.tip = `${request.client} asks to see “${request.prompt}”`;
  }
  emptyHint.textContent = request ? ASKED_HINT : restingHint;
  const offered = request?.mode ?? 'region';
  for (const tile of modeTiles) {
    const first = tile.dataset.start === offered;
    tile.classList.toggle('primary', first);
    tile.classList.toggle('glassy', !first);
  }
  copyLabel.textContent = request && !video ? `Send to ${request.client}` : 'Copy and Close';
  countDown();
  syncTools();
}

/** For a tool that gives up -- most stop waiting after a minute -- how long is
 *  left, counted down in the bar. At nothing it goes: the tool has either let
 *  go, and Rust will say so, or is waiting after all. */
let waitTimer: number | undefined;
function countDown() {
  window.clearTimeout(waitTimer);
  const deadline = request?.deadline;
  const left = deadline ? deadline - Date.now() : 0;
  // A long wait -- Warp's half hour -- is counted only once it is nearly up.
  requestWait.hidden = left <= 0 || left > 10 * 60_000;
  if (left <= 0) return;
  if (left > 10 * 60_000) { waitTimer = window.setTimeout(countDown, left - 10 * 60_000); return; }
  const seconds = Math.ceil(left / 1000);
  requestWait.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left`;
  requestWait.classList.toggle('soon', seconds <= 15);
  // On the second, counted from the deadline, so the numbers change evenly.
  waitTimer = window.setTimeout(countDown, left % 1000 || 1000);
}

let revision = 0;
async function refresh() {
  const ticket = ++revision;
  try {
    const snapshot = await command<Snapshot>('current_capture');
    if (disposed || ticket !== revision) return;
    capture = snapshot.capture; busy = snapshot.busy; request = snapshot.request ?? null;
    if (snapshot.error || flashTimer === undefined) showMessage(snapshot.error);
    render();
  } catch (error) { report(error); }
}
function report(error: unknown) { console.error('[Mark]', error); showMessage(String(error)); }

async function dismiss() {
  if (busy || copyPending) return;
  if (isTauri) { await command('dismiss_editor'); }
  capture = null; showMessage(null); render(); start.focus();
}

/** Flatten the capture and its arrows at natural resolution -- framed, when
 *  Frame is on, in the same numbers the canvas showed it in. Unframed, it can
 *  be drawn smaller, marks and all, as Send draws it for an AI tool. */
async function flatten(framed = frame.on, size?: { width: number; height: number }): Promise<HTMLCanvasElement> {
  const source = new Image();
  source.src = capture!.dataUrl;
  await source.decode();
  const { width, height } = capture!;
  const geometry = framed ? frameGeometry(width, height, capture!.scale ?? 1, frame) : null;
  const canvas = document.createElement('canvas');
  const scaled = !geometry && size && (size.width !== width || size.height !== height) ? size : null;
  canvas.width = geometry?.width ?? scaled?.width ?? width; canvas.height = geometry?.height ?? scaled?.height ?? height;
  const context = canvas.getContext('2d')!;
  if (scaled) {
    context.imageSmoothingQuality = 'high';
    context.scale(scaled.width / width, scaled.height / height);
  }
  const draw = () => {
    context.drawImage(source, 0, 0, width, height);
    // The image's own size, which badges are kept inside: not the frame's.
    drawAnnotations(context, layer.annotations, { source, notes: layer.notes, density: layer.density, width, height });
  };
  if (geometry) paintFrame(context, geometry, frame, { width, height, dark: darkTop(source, width, height) }, draw);
  else draw();
  return canvas;
}

/** Saving and sharing always send the flattened image: a file should be what is
 *  on screen, crop and annotations included. */
async function exportImage(via: 'save_image' | 'share_image') {
  if (!capture || busy || copyPending) return;
  if (capture.video) { await exportVideo(via === 'save_image' ? 'save' : 'share'); return; }
  copyPending = true; render();
  try {
    const png = (await flatten()).toDataURL('image/png').split(',')[1];
    const saved = await command<string | null>(via, { png, name: suggestedName() });
    if (via === 'save_image') flash(saved ? `Saved as ${saved}.` : 'Not saved.');
  } catch (error) { report(error); }
  finally { copyPending = false; render(); }
}

// ---- a recording ----------------------------------------------------------------
/** A recording plays where a screenshot would be drawn on: the movie over its
 *  own first frame, which is what stands for it in Recent and is there while
 *  the movie loads. Under it, the trim: the part between the handles is what
 *  Copy, Save and Share take, and what plays, round and round. */

/** Which recording's frames the strip holds, so frames arriving late for one
 *  since closed are not shown under the next. */
let framesFor = 0;
async function loadFrames(id: number) {
  framesFor = id;
  stripFrames.replaceChildren();
  const frames = await command<string[]>('video_frames', { id, count: 10 }).catch(() => [] as string[]);
  if (framesFor !== id) return;
  stripFrames.replaceChildren(...frames.map(url => Object.assign(new Image(), { src: url, alt: '' })));
}

/** Put a recording in the player, kept as `keep` says or all of it -- or, for
 *  anything else, take the player down. */
function showMovie(next: CapturePreview | null, keep?: Trim) {
  const video = next?.video ?? null;
  movie.pause();
  // Marks on a recording are shown from the moment they are drawn at, so the
  // layer stamps each with the playhead's time and shows only those due.
  layer.live = !!video;
  layer.stamp = video ? () => ({ at: Math.round(movie.currentTime * 1000) / 1000 }) : null;
  layer.showing = video ? item => (item.at ?? 0) <= movie.currentTime + DUE : null;
  shownMarks = '';
  if (!video) {
    movie.hidden = true;
    if (movie.hasAttribute('src')) { movie.removeAttribute('src'); movie.removeAttribute('poster'); movie.load(); }
    trim = null; framesFor = 0; stripFrames.replaceChildren();
    return;
  }
  movie.hidden = false;
  movie.poster = next!.dataUrl;
  movie.src = videoSource(video.path);
  trim = keep ? { ...keep } : everything(video.duration);
  void loadFrames(video.id);
  drawTrim();
}
on(movie, 'loadedmetadata', () => { if (trim) movie.currentTime = trim.start; drawTrim(); });
// Drawing on a recording that is playing stops it there, so the mark is
// stamped with the frame it was drawn on, and stays still to be drawn.
overlay.addEventListener('pointerdown', () => { if (capture?.video && !movie.paused) movie.pause(); },
                         { capture: true, signal: abort.signal });

/** A mark is due a frame early rather than a frame late: drawn at a moment,
 *  it is on that moment's frame. */
const DUE = 1 / 60;
/** Which marks the layer last drew, so it redraws only when that changes. */
let shownMarks = '';
function showDueMarks() {
  const due = layer.annotations.filter(item => layer.showing?.(item) ?? true).map(item => item.id).join(',');
  if (due !== shownMarks) { shownMarks = due; layer.render(); }
}

/** The handles, the shading outside them, the playhead and the time, from
 *  the trim and where the movie is -- and the marks due by then, and when the
 *  one selected appears. */
function drawTrim() {
  const video = capture?.video;
  if (!video || !trim) return;
  showDueMarks();
  const one = layer.selection.length === 1 ? layer.selection[0] : null;
  markAt.hidden = !one;
  if (one && draggingAt === null) {
    markAt.style.left = `${Math.min(100, Math.max(0, ((one.at ?? 0) / (video.duration || 1)) * 100))}%`;
    markAt.dataset.tip = `Appears at ${clock(one.at ?? 0)}: drag to change it`;
  }
  const length = video.duration || 1;
  const at = (seconds: number) => `${Math.min(100, Math.max(0, (seconds / length) * 100))}%`;
  kept.style.left = at(trim.start);
  kept.style.right = `calc(100% - ${at(trim.end)})`;
  for (const edge of strip.querySelectorAll<HTMLElement>('.edge')) {
    const seconds = edge.dataset.edge === 'start' ? trim.start : trim.end;
    edge.style.left = at(seconds);
    edge.setAttribute('aria-valuemin', '0');
    edge.setAttribute('aria-valuemax', String(length));
    edge.setAttribute('aria-valuenow', String(seconds));
    edge.setAttribute('aria-valuetext', clock(seconds));
  }
  playhead.style.left = at(movie.currentTime || trim.start);
  const playing = !movie.paused;
  playButton.classList.toggle('playing', playing);
  playButton.querySelector('.when-paused')!.toggleAttribute('hidden', playing);
  playButton.querySelector('.when-playing')!.toggleAttribute('hidden', !playing);
  playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  playButton.dataset.tip = playing ? 'Pause (Space)' : 'Play (Space)';
  trimTime.textContent = whole(trim, length) ? clock(length) : `${clock(trim.end - trim.start)} of ${clock(length)}`;
  trimBar.classList.toggle('trimmed', !whole(trim, length));
}

/** Playing, the playhead moves every frame, and at the end of the part kept
 *  goes back to its start. */
function follow() {
  if (movie.paused || !trim) return;
  if (movie.currentTime >= trim.end - 0.01) movie.currentTime = trim.start;
  drawTrim();
  requestAnimationFrame(follow);
}
on(movie, 'play', () => { drawTrim(); requestAnimationFrame(follow); });
on(movie, 'pause', () => drawTrim());
on(movie, 'ended', () => { if (trim) { movie.currentTime = trim.start; void movie.play().catch(() => {}); } });

function togglePlay() {
  if (!trim || movie.hidden) return;
  if (movie.paused) {
    movie.currentTime = playFrom(movie.currentTime, trim);
    void movie.play().catch(report);
  } else movie.pause();
}
on(playButton, 'click', () => togglePlay());

/** Move one end of the part kept, and show the frame it is now on. */
function setEdge(edge: 'start' | 'end', seconds: number) {
  const video = capture?.video;
  if (!video || !trim) return;
  trim = moveEdge(trim, edge, seconds, video.duration);
  movie.pause();
  movie.currentTime = edge === 'start' ? trim.start : trim.end;
  drawTrim();
}

/** Where on the strip a pointer is, in seconds into the recording. */
function stripTime(event: PointerEvent): number {
  const box = strip.getBoundingClientRect();
  return Math.min(1, Math.max(0, (event.clientX - box.left) / Math.max(box.width, 1))) * (capture?.video?.duration ?? 0);
}
/** A handle is dragged; anywhere else on the strip moves the playhead there. */
let dragging: 'start' | 'end' | 'seek' | 'mark' | null = null;
/** Where the selected mark's time is being dragged to, until it is let go. */
let draggingAt: number | null = null;
on(strip, 'pointerdown', event => {
  if (!capture?.video || event.button !== 0) return;
  event.preventDefault();
  if ((event.target as Element).closest('.mark-at')) {
    dragging = 'mark'; draggingAt = stripTime(event);
    strip.setPointerCapture(event.pointerId);
    return;
  }
  const edge = (event.target as Element).closest<HTMLElement>('.edge')?.dataset.edge as 'start' | 'end' | undefined;
  dragging = edge ?? 'seek';
  strip.setPointerCapture(event.pointerId);
  if (!edge) { movie.currentTime = stripTime(event); drawTrim(); }
});
on(strip, 'pointermove', event => {
  if (!dragging) return;
  if (dragging === 'mark') {
    // Shows the frame it will now appear on, and moves when let go: one undo.
    draggingAt = stripTime(event);
    movie.currentTime = draggingAt;
    markAt.style.left = `${(draggingAt / (capture!.video!.duration || 1)) * 100}%`;
    drawTrim();
  } else if (dragging === 'seek') { movie.currentTime = stripTime(event); drawTrim(); }
  else setEdge(dragging, stripTime(event));
});
const letGo = (event: PointerEvent) => {
  const one = layer.selection.length === 1 ? layer.selection[0] : null;
  if (dragging === 'mark' && draggingAt !== null && one) layer.retime(one.id, Math.round(draggingAt * 1000) / 1000);
  dragging = null; draggingAt = null;
  drawTrim();
  if (strip.hasPointerCapture(event.pointerId)) strip.releasePointerCapture(event.pointerId);
};
on(strip, 'pointerup', letGo);
on(strip, 'pointercancel', letGo);
/** A handle with the keyboard: a tenth of a second at a time, a second with Shift. */
on(strip, 'keydown', event => {
  const edge = (event.target as Element).closest<HTMLElement>('.edge')?.dataset.edge as 'start' | 'end' | undefined;
  if (!edge || !trim || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
  event.preventDefault();
  const step = (event.shiftKey ? 1 : 0.1) * (event.key === 'ArrowLeft' ? -1 : 1);
  setEdge(edge, trim[edge] + step);
});

/** The name the movie was recorded under, which Save offers again, as what
 *  it is being saved as. */
function videoName(extension: string): string {
  const file = capture?.video?.path.split('/').pop() ?? '';
  const stem = file.replace(/\.mp4$/i, '');
  return stem ? `${stem}.${extension}` : suggestedName(new Date(shownAt || Date.now()), extension);
}

/** Copy: the movie, or the part kept, on the clipboard as a file -- which a
 *  message, a mail or a chat takes as an attachment. A trim is made first,
 *  which takes a moment for a long one. */
async function copyVideo(close: boolean) {
  const video = capture?.video;
  if (!video || busy || copyPending) return;
  const part = trim ?? everything(video.duration);
  movie.pause();
  copyPending = true; render(); showMessage(null);
  const marks = videoMarks();
  const trimming = marks ? working('Drawing the marks into the recording…')
    : whole(part, video.duration) ? null : working('Trimming the recording…');
  try {
    await command('copy_video', { id: video.id, start: part.start, end: part.end, close, marks });
    if (close) { capture = null; showMessage(null); }
    else flash('Copied the recording. Paste it into a message, a mail or a chat.');
  } catch (error) { report(error); }
  finally { trimming?.(); copyPending = false; render(); }
}

/** Save, as a movie or as a GIF that loops, or Share: the part kept. */
async function exportVideo(how: 'save' | 'gif' | 'share') {
  const video = capture?.video;
  if (!video || busy || copyPending || !isTauri) return;
  const part = trim ?? everything(video.duration);
  movie.pause();
  copyPending = true; render();
  const marks = videoMarks();
  try {
    if (how === 'share') await command('share_video', { id: video.id, start: part.start, end: part.end, marks });
    else {
      const saved = await command<string | null>('save_video', {
        id: video.id, start: part.start, end: part.end, gif: how === 'gif', name: videoName(how === 'gif' ? 'gif' : 'mp4'), marks,
      });
      flash(saved ? `Saved as ${saved}.` : 'Not saved.');
    }
  } catch (error) { report(error); }
  finally { copyPending = false; render(); }
}

/** The keys a recording answers to before a screenshot's: playing, trimming,
 *  and copying and saving it as a movie. False hands the key on to what a
 *  screenshot answers to -- drawing, undo, selecting, Escape -- less what a
 *  recording goes without: cropping, zooming, Copy Text, Hide Sensitive. */
function videoKey(event: KeyboardEvent, key: string): boolean {
  const commanded = event.metaKey || event.ctrlKey;
  const done = (act: () => void) => { event.preventDefault(); act(); return true; };
  const without = () => { event.preventDefault(); return true; };
  // A focused button takes Space itself, and would be pressed twice.
  if (key === ' ' && !commanded) return event.target instanceof HTMLButtonElement ? true : done(togglePlay);
  if (!commanded && !event.altKey && !event.shiftKey && key === 'i') return done(() => setEdge('start', movie.currentTime));
  if (!commanded && !event.altKey && !event.shiftKey && key === 'o') return done(() => setEdge('end', movie.currentTime));
  if (!commanded && key === 'c') return without();
  if (commanded && event.altKey && (event.code === 'KeyC' || key === 'c' || key === 'ç')) return done(primary);
  if (commanded && key === 'c') return done(() => { void copyVideo(false); });
  if (commanded && event.altKey && (event.code === 'KeyS' || key === 's' || key === 'ß')) return done(() => { void exportVideo('gif'); });
  if (commanded && key === 's') return done(() => { void exportVideo(event.shiftKey ? 'share' : 'save'); });
  if (commanded && ['=', '+', '-', '0', '1'].includes(key)) return without();
  if (commanded && event.shiftKey && (key === 't' || key === 'r')) return without();
  return false;
}

/** What is drawn on a recording, as Rust draws it into every frame: one
 *  picture of the marks for each moment a mark appears at -- all of those due
 *  by then, numbered as among all of them -- and each redaction, which Rust
 *  pixelates afresh in every frame, since a recording's pixels change under it.
 *  None when nothing is drawn, so the movie goes as it was. */
interface VideoMarks {
  overlays: { at: number; png: string }[];
  redactions: { x: number; y: number; width: number; height: number; at: number; block: number }[];
}
function videoMarks(): VideoMarks | null {
  if (!capture?.video) return null;
  const drawn = layer.annotations.filter(item => item.kind !== 'redact');
  const hidden = layer.annotations.filter((item): item is Shape => item.kind === 'redact');
  if (!drawn.length && !hidden.length) return null;
  const { width, height } = capture;
  const moments = [...new Set(drawn.map(item => item.at ?? 0))].sort((a, b) => a - b);
  const overlays = moments.map(at => {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    drawAnnotations(canvas.getContext('2d')!, drawn, {
      notes: layer.notes, density: layer.density, width, height, showing: item => (item.at ?? 0) <= at,
    });
    return { at, png: canvas.toDataURL('image/png').split(',')[1] };
  });
  const redactions = hidden.map(shape => ({
    x: Math.min(shape.x, shape.x + shape.width), y: Math.min(shape.y, shape.y + shape.height),
    width: Math.abs(shape.width), height: Math.abs(shape.height), at: shape.at ?? 0, block: blockSize(shape.weight),
  }));
  return { overlays, redactions };
}

/** A box, ellipse or highlight on its own in the selection: Copy Text then
 *  copies only the words inside it. A redaction hides its words, so not that. */
function textArea(): { x: number; y: number; width: number; height: number } | null {
  const picked = layer.selection;
  const shape = picked.length === 1 ? picked[0] : null;
  if (!shape || (shape.kind !== 'box' && shape.kind !== 'ellipse' && shape.kind !== 'highlight')) return null;
  return { x: Math.min(shape.x, shape.x + shape.width), y: Math.min(shape.y, shape.y + shape.height),
           width: Math.abs(shape.width), height: Math.abs(shape.height) };
}

/** Say what is being done until it is done, not for a moment: the first time
 *  a Mac reads text for Mark it prepares its recognition, which takes seconds
 *  rather than the half a second it takes every time after, and a message that
 *  had gone by then would make it look as though nothing were happening. */
function working(what: string): () => void {
  showMessage(what);
  const slow = window.setTimeout(() => showMessage(`${what} The first time can take a few seconds.`), 2500);
  return () => window.clearTimeout(slow);
}

/** Copy Text: the words in the capture -- as it stands, cropped, without the
 *  marks drawn on it -- read on the Mac and copied in reading order. With a box
 *  selected, only the words inside it. */
async function copyText() {
  if (!capture || busy || copyPending) return;
  if (!isTauri) { flash('Copy Text reads the image on your Mac, so it works in the Mac app.'); return; }
  const area = textArea();
  copyPending = true; render();
  const done = working(area ? 'Reading the text in the box…' : 'Reading the text…');
  try {
    const lines = await command<TextLine[]>('recognize_text', { png: capture.dataUrl.split(',')[1] });
    const text = readingOrder(area ? within(lines, area) : lines);
    if (!text) { flash(area ? 'No text inside the box.' : 'No text in the image.'); return; }
    await command('copy_text', { text });
    const count = text.split('\n').length;
    flash(`Copied ${count} ${count === 1 ? 'line' : 'lines'} of text${area ? ' from the box' : ''}.`);
  } catch (error) { report(error); }
  finally { done(); copyPending = false; render(); }
}

/** Hide Sensitive: read the capture on the Mac, find the email addresses,
 *  phone and card numbers, keys and faces in it, and pixelate each one -- as
 *  one step, so ⌘Z takes them all back, and selected, to be looked over. */
async function hideSensitive() {
  if (!capture || busy || copyPending) return;
  if (!isTauri) { flash('Hide Sensitive reads the image on your Mac, so it works in the Mac app.'); return; }
  copyPending = true; render();
  const done = working('Looking for anything sensitive…');
  try {
    const scan = await command<{ lines: TextLine[]; faces: Area[] }>('scan_image', { png: capture.dataUrl.split(',')[1] });
    const found = findSensitive(scan?.lines ?? [], scan?.faces ?? []);
    const added = layer.addRedactions(found.map(item => item.area));
    flash(added.length
      ? `${describeHidden(found)} ⌘Z puts ${added.length === 1 ? 'it' : 'them'} back.`
      : 'Nothing sensitive found: no email addresses, phone or card numbers, keys or faces.');
  } catch (error) { report(error); }
  finally { done(); copyPending = false; render(); }
}

async function copyCapture(close = true) {
  if (!capture || busy || copyPending) return;
  if (capture.video) { await copyVideo(close); return; }
  // The image is what goes to the clipboard, whatever is selected. Anything
  // selected is held as well, so copying a mark and pasting it works the way
  // it does everywhere else -- in this capture, or the next.
  const held = layer.copySelection();
  copyPending = true; render(); showMessage(null);
  try {
    if (isTauri) {
      // An untouched capture keeps its original bytes; only a drawing re-encodes.
      // A crop makes the original bytes wrong, so it forces a re-encode too, and
      // so does a frame, which is new pixels all round the old ones.
      if (layer.empty && !mustFlatten && !frame.on) await command('copy_capture', { close });
      else await command('copy_edited', { png: (await flatten()).toDataURL('image/png').split(',')[1], close });
      if (close) capture = null; else flash(`Copied to clipboard.${heldHint(held)}${listHint()}`);
    } else {
      // Start clipboard.write inside the gesture; Safari accepts a promised Blob.
      const png = layer.empty && !frame.on
        ? fetch(capture.dataUrl).then(response => response.blob())
        : flatten().then(canvas => new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('The image could not be encoded.'))), 'image/png')));
      await copyThenDismiss(async () => {
        if (!navigator.clipboard?.write) throw new Error('Image copying needs clipboard access on localhost or HTTPS.');
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      }, () => { if (close) capture = null; });
      flash(`Copied to clipboard.${heldHint(held)}${listHint()}`);
    }
  } catch (error) { report(error); }
  finally { copyPending = false; render(); }
}

/** Send: the capture with its marks -- not its frame, which is for people --
 *  at the size Claude looks at, to the AI tool that asked, with the words to
 *  go with it: what was drawn where, and the text in it. Rust puts the editor
 *  away after, as Copy and Close does. */
async function send() {
  if (!capture || !request || busy || copyPending) return;
  const asked = request, sending = capture;
  copyPending = true; render(); showMessage(null);
  let reading: (() => void) | null = null;
  try {
    let size = sendSize(sending.width, sending.height);
    let png = (await flatten(false, size)).toDataURL('image/png').split(',')[1];
    // A capture full of photographs can still be large at that size: smaller
    // again, until it is within what one image may be.
    while (png.length > MAX_BASE64 && size.width > 64 && size.height > 64) {
      size = { width: Math.round(size.width * 0.8), height: Math.round(size.height * 0.8) };
      png = (await flatten(false, size)).toDataURL('image/png').split(',')[1];
    }
    // The text in it, read off the very picture being sent -- so nothing a
    // redaction hides can come back as words. A Mac that can't read it, or a
    // browser that has nothing to read with, sends the picture without them.
    reading = working('Reading the text to send with it…');
    const words = await command<TextLine[]>('recognize_text', { png })
      .then(lines => readingOrder(lines ?? [])).catch(() => '');
    const marks = describeMarks(layer.annotations, size.width / sending.width);
    const text = resultText({ capture: sending, sent: size, marks, words });
    await command('send_capture', { id: asked.id, png, text });
    capture = null; request = null;
    showMessage(null);
  } catch (error) { report(error); }
  finally { reading?.(); copyPending = false; render(); }
}

/** The footer's primary button, ⌥⌘C and the menu's Copy and Close are one
 *  action: it sends while an AI tool's ask waits, and copies and closes
 *  otherwise. One function, so no way to it can do the other thing. */
function primary() {
  // An ask is for a screenshot: a recording open meanwhile is copied as ever.
  if (request && !capture?.video) void send(); else void copyCapture(true);
}

function on<K extends keyof HTMLElementEventMap>(element: HTMLElement, name: K, handler: (event: HTMLElementEventMap[K]) => void) {
  element.addEventListener(name, handler, { signal: abort.signal });
}
on(copy, 'click', () => primary());
// Don't Send: the tool is told no, and the capture stays, to copy or close.
on(requestBar.querySelector<HTMLButtonElement>('.request-decline')!, 'click', () => {
  if (!request) return;
  const asked = request;
  void command('decline_request', { id: asked.id }).then(() => flash(`Nothing was sent to ${asked.client}.`)).catch(report);
});
on(copyOnly, 'click', () => { void copyCapture(false); });
// ⌘W's button: out without copying, and nothing lost, since what closes waits in Recent.
on(closeButton, 'click', () => { void dismiss().catch(report); });
on(saveButton, 'click', () => { void exportImage('save_image'); });
on(saveMore, 'click', event => {
  event.stopPropagation();
  if (saveMenu.hidden) openSaveMenu(); else closeSaveMenu();
});
on(saveMenu, 'click', event => {
  const how = (event.target as Element).closest<HTMLButtonElement>('[data-save]')?.dataset.save as 'save' | 'gif' | undefined;
  if (!how) return;
  closeSaveMenu();
  void exportVideo(how);
});
document.addEventListener('pointerdown', event => {
  if (!saveMenu.hidden && !saveMenu.contains(event.target as Node) && !saveMore.contains(event.target as Node)) closeSaveMenu();
}, { signal: abort.signal });
/** Over the footer, its right edge under the ▾ it came from. */
function openSaveMenu() {
  saveMenu.hidden = false;
  saveMore.setAttribute('aria-expanded', 'true');
  hideTip();
  const at = saveMore.getBoundingClientRect(), frame = app.getBoundingClientRect();
  saveMenu.style.right = `${Math.max(8, frame.right - at.right)}px`;
  saveMenu.style.bottom = `${frame.bottom - at.top + 8}px`;
  saveMenu.querySelector<HTMLButtonElement>('button')?.focus();
}
function closeSaveMenu(refocus = false) {
  if (saveMenu.hidden) return;
  saveMenu.hidden = true;
  saveMore.setAttribute('aria-expanded', 'false');
  if (refocus) saveMore.focus();
}
on(copyTextButton, 'click', () => { void copyText(); });
on(hideButton, 'click', () => { void hideSensitive(); });
on(shareButton, 'click', () => { void exportImage('share_image'); });
on(app.querySelector<HTMLElement>('.modes')!, 'click', event => {
  const mode = (event.target as Element).closest<HTMLButtonElement>('[data-start]')?.dataset.start;
  if (mode) startCapture(mode as CaptureMode);
});
on(app.querySelector<HTMLButtonElement>('.capture-go')!, 'click', () => startCapture('region'));
on(captureMore, 'click', event => {
  event.stopPropagation();
  const open = captureMenu.hidden;
  captureMenu.hidden = !open;
  captureMore.setAttribute('aria-expanded', String(open));
});
on(captureMenu, 'click', event => {
  const mode = (event.target as Element).closest<HTMLButtonElement>('[data-mode]')?.dataset.mode;
  if (mode) startCapture(mode as CaptureMode);
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
  if (button.dataset.tip !== undefined) button.dataset.tip = tipOf(choice);
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
    item.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${choice.art}</svg><span>${choice.name}</span>`
      + `<kbd aria-hidden="true">${choice.key.toUpperCase()}</kbd>`;
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

/** A tool's key picks its slot as a click on the rail does. Pressed with that
 *  slot already in hand, it goes on to the slot's next way of drawing that
 *  answers to the same key; a key for one particular way, M for Measure, goes
 *  straight to it. */
function pickByKey(key: string): boolean {
  for (const [slot, choices] of SLOTS.entries()) {
    const answering = choices.map((choice, variant) => ({ choice, variant })).filter(({ choice }) => choice.key === key);
    if (!answering.length) continue;
    const current = choices[worn[slot]];
    const inHand = current.id === layer.tool && !!current.numbered === layer.style.numbered;
    const at = answering.findIndex(({ variant }) => variant === worn[slot]);
    const next = at < 0 ? answering[0] : inHand ? answering[(at + 1) % answering.length] : answering[at];
    wear(slot, next.variant);
    layer.deselect();
    return true;
  }
  return false;
}

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
// ---- any colour -------------------------------------------------------------------
/** A colour that is none of the eight, used like a swatch and kept for the session. */
function useColour(color: string) {
  layer.restyle({ color });
  const known = customColours.indexOf(color);
  if (known >= 0) customColours.splice(known, 1);
  if (!COLORS.some(swatch => swatch.value === color)) customColours.unshift(color);
  customColours.length = Math.min(customColours.length, 5);
  recentColours.replaceChildren(...customColours.map(value => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch';
    button.dataset.recent = value;
    button.style.setProperty('--swatch', value);
    button.setAttribute('aria-label', value.toUpperCase());
    return button;
  }));
}
function openColourMenu() {
  colourMenu.hidden = false;
  customSwatch.setAttribute('aria-expanded', 'true');
  hideTip();
  hexField.value = layer.style.color.toUpperCase();
  hexField.removeAttribute('aria-invalid');
  hexField.focus();
  hexField.select();
}
function closeColourMenu(refocus = false) {
  if (colourMenu.hidden) return;
  colourMenu.hidden = true;
  customSwatch.setAttribute('aria-expanded', 'false');
  if (refocus) customSwatch.focus();
}
on(customSwatch, 'click', () => { if (colourMenu.hidden) openColourMenu(); else closeColourMenu(); });
on(hexField, 'keydown', event => {
  if ((event as KeyboardEvent).key !== 'Enter') return;
  event.preventDefault();
  const color = hexColour(hexField.value);
  if (!color) { hexField.setAttribute('aria-invalid', 'true'); return; }
  useColour(color);
  closeColourMenu(true);
});
on(hexField, 'input', () => hexField.removeAttribute('aria-invalid'));
on(colourMenu, 'keydown', event => {
  // Its own Escape: the field would otherwise hand it on to the editor, and
  // the editor's Escape backs out of the capture.
  if ((event as KeyboardEvent).key !== 'Escape' || colourMenu.hidden) return;
  event.preventDefault();
  event.stopPropagation();
  closeColourMenu(true);
});
on(recentColours, 'click', event => {
  const color = (event.target as Element).closest<HTMLButtonElement>('[data-recent]')?.dataset.recent;
  if (color) { useColour(color); closeColourMenu(true); }
});
document.addEventListener('pointerdown', event => {
  if (!colourMenu.hidden && !colourMenu.parentElement!.contains(event.target as Node)) closeColourMenu();
}, { signal: abort.signal });

/** The eyedropper: the next press on the image takes the colour of the pixel
 *  under it -- the screenshot's own, not a mark's -- and never draws. */
let picking = false;
let sampler: { src: string; context: CanvasRenderingContext2D } | null = null;
const loupe = document.createElement('div');
loupe.className = 'loupe';
loupe.hidden = true;
app.append(loupe);
function sampleAt(event: MouseEvent): string | null {
  if (!image.complete || !image.naturalWidth) return null;
  if (sampler?.src !== image.src) {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(image, 0, 0);
    sampler = { src: image.src, context };
  }
  const box = overlay.getBoundingClientRect();
  const x = Math.floor(((event.clientX - box.left) / box.width) * image.naturalWidth);
  const y = Math.floor(((event.clientY - box.top) / box.height) * image.naturalHeight);
  if (x < 0 || y < 0 || x >= image.naturalWidth || y >= image.naturalHeight) return null;
  const [r, g, b] = sampler.context.getImageData(x, y, 1, 1).data;
  return `#${[r, g, b].map(value => value.toString(16).padStart(2, '0')).join('')}`;
}
function stopPicking() {
  picking = false;
  overlay.classList.remove('picking');
  loupe.hidden = true;
}
on(colourMenu.querySelector<HTMLButtonElement>('.pick')!, 'click', () => {
  closeColourMenu();
  // The button it was opened from is hidden now; keys go to the editor, which
  // is what Escape has to reach to put the eyedropper down.
  (document.activeElement as HTMLElement | null)?.blur();
  picking = true;
  overlay.classList.add('picking');
  flash('Click the image to take its colour. Escape cancels.');
});
// Ahead of the drawing, so a press meant for the eyedropper never becomes a mark.
stage.addEventListener('pointerdown', event => {
  if (!picking) return;
  event.preventDefault();
  event.stopPropagation();
  const color = sampleAt(event);
  stopPicking();
  if (color) useColour(color);
}, { capture: true, signal: abort.signal });
stage.addEventListener('pointermove', event => {
  if (!picking) return;
  const color = sampleAt(event);
  loupe.hidden = !color;
  if (!color) return;
  const frame = app.getBoundingClientRect();
  loupe.style.setProperty('--swatch', color);
  loupe.style.transform = `translate(${event.clientX - frame.left + 14}px, ${event.clientY - frame.top + 14}px)`;
}, { signal: abort.signal });

on(undoButton, 'click', () => { stepBack(); });
on(cropApply, 'click', () => { void applyCrop().catch(report); });
on(cropShapes, 'click', event => {
  const chosen = (event.target as Element).closest<HTMLButtonElement>('[data-shape]');
  const shape = CROP_SHAPES.find(item => item.id === chosen?.dataset.shape);
  if (!chosen || !shape || !capture) return;
  for (const button of cropShapes.querySelectorAll('[data-shape]')) button.setAttribute('aria-checked', String(button === chosen));
  layer.setCropRatio(shape.id === 'original' ? capture.width / capture.height : shape.ratio);
});
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
/** The canvas's room for the capture: its size less its padding, which keeps
 *  the top clear for an AI tool's ask while one waits. */
function canvasRoom(): { width: number; height: number } {
  const style = getComputedStyle(canvasArea);
  const pad = (side: 'Top' | 'Right' | 'Bottom' | 'Left') => parseFloat(style[`padding${side}`]) || 0;
  return { width: canvasArea.clientWidth - pad('Left') - pad('Right'), height: canvasArea.clientHeight - pad('Top') - pad('Bottom') };
}

function startingZoom(next: CapturePreview): 'fit' | number {
  const room = canvasRoom();
  if (!room.width || !room.height) return 1;      // before first layout
  const ratio = 1 / (next.scale || 1);
  const size = frame.on ? frameGeometry(next.width, next.height, next.scale ?? 1, frame) : next;
  const fits = size.width * ratio <= room.width - 52 && size.height * ratio <= room.height - 52;
  return fits ? 1 : 'fit';
}

function applyZoom() {
  const fitted = zoom === 'fit';
  stage.classList.toggle('zoomed', !fitted);
  canvasArea.classList.toggle('scrolls', !fitted);
  if (layoutFrame()) { /* framed: laid out, stage and all, in pixels */ }
  else if (!fitted && capture) {
    const ratio = pixelRatio(zoom as number);
    stage.style.width = `${Math.round(capture.width * ratio)}px`;
    stage.style.height = `${Math.round(capture.height * ratio)}px`;
  } else {
    stage.style.width = ''; stage.style.height = '';
  }
  zoomSelect.value = fitted ? 'fit' : String(zoom);
  layer.measure();
}

/** The frame on the canvas, in the numbers the export draws it in, scaled to
 *  the screen: at Fit, the whole framed image fits the canvas and is never
 *  shown larger than its own pixels, as an unframed capture never is; at a
 *  zoom, it is scaled as the capture is. The stage stays the image's own box
 *  inside it, so drawing, measuring and pointing work exactly as unframed.
 *  Says whether it laid the stage out; off, the backdrop and the card are no
 *  boxes at all and the stage is left to lay out as it always has. */
function layoutFrame(): boolean {
  const on = frame.on && !!capture && !capture.video;
  canvasArea.classList.toggle('framed', on);
  if (!on) {
    for (const element of [backdrop, card, chrome]) element.removeAttribute('style');
    stage.style.removeProperty('top'); stage.style.removeProperty('border-radius');
    chrome.hidden = true;
    return false;
  }
  const { width, height } = capture!;
  const geometry = frameGeometry(width, height, capture!.scale ?? 1, frame);
  const room = canvasRoom();
  const k = zoom === 'fit'
    ? Math.min(1, room.width / geometry.width, room.height / geometry.height)
    : pixelRatio(zoom);
  const px = (value: number) => `${value * k}px`;
  const corner = px(geometry.radius);
  backdrop.style.width = px(geometry.width); backdrop.style.height = px(geometry.height);
  backdrop.style.background = cssBackground(backgroundOf(frame.background));
  Object.assign(card.style, {
    left: px(geometry.pad), top: px(geometry.pad), width: px(width), height: px(height + geometry.bar), borderRadius: corner,
    boxShadow: geometry.shadow.alpha
      ? `0 ${px(geometry.shadow.y)} ${px(geometry.shadow.blur)} rgba(0, 0, 0, ${geometry.shadow.alpha.toFixed(3)})` : 'none',
  });
  chrome.hidden = !geometry.bar;
  if (geometry.bar) {
    const colours = barDark ? BAR_COLOURS.dark : BAR_COLOURS.light;
    const line = Math.max(1, Math.round(geometry.bar / 28));
    Object.assign(chrome.style, {
      height: px(geometry.bar), borderRadius: `${corner} ${corner} 0 0`,
      background: `${LIGHTS_SVG} left center / auto 100% no-repeat, ${colours.fill}`,
      boxShadow: `inset 0 -${px(line)} 0 ${colours.line}`,
    });
  }
  Object.assign(stage.style, {
    top: px(geometry.bar), width: px(width), height: px(height),
    borderRadius: geometry.bar ? `0 0 ${corner} ${corner}` : corner,
  });
  return true;
}

// At Fit a framed capture is sized from the canvas, so it follows the window.
const canvasWatch = new ResizeObserver(() => { if (frame.on && capture && zoom === 'fit') { layoutFrame(); layer.measure(); } });
canvasWatch.observe(canvasArea);
cleanups.push(() => canvasWatch.disconnect());
on(image, 'load', () => { barDark = darkTop(image, image.naturalWidth, image.naturalHeight); layoutFrame(); });

/** The panel says what the frame is; the footer button says whether there is one. */
function syncFramePanel() {
  frameSwitch.setAttribute('aria-checked', String(frame.on));
  frameButton.classList.toggle('on', frame.on);
  for (const swatch of framePanel.querySelectorAll<HTMLButtonElement>('.background')) {
    swatch.setAttribute('aria-checked', String(swatch.dataset.background === frame.background));
  }
  for (const input of framePanel.querySelectorAll<HTMLInputElement>('input[data-frame]')) {
    const value = frame[input.dataset.frame as keyof FrameStyle];
    if (input.type === 'checkbox') input.checked = value === true;
    else input.value = String(value);
  }
}

/** Change the frame, show it, and -- unless a slider is still moving -- keep it
 *  for the next capture and the next launch. */
function setFrame(change: Partial<FrameStyle>, keep = true) {
  frame = { ...frame, ...change };
  syncFramePanel();
  render();
  if (keep && isTauri) void command('set_frame', { frame }).catch(report);
}

function placeFramePanel() {
  const button = frameButton.getBoundingClientRect(), box = framePanel.getBoundingClientRect();
  const left = Math.min(Math.max(8, button.right - box.width), innerWidth - box.width - 8);
  Object.assign(framePanel.style, { left: `${left}px`, bottom: `${innerHeight - button.top + 10}px` });
}
function openFramePanel() {
  framePanel.hidden = false;
  frameButton.setAttribute('aria-expanded', 'true');
  placeFramePanel();
}
function closeFramePanel(refocus = false) {
  if (framePanel.hidden) return;
  framePanel.hidden = true;
  frameButton.setAttribute('aria-expanded', 'false');
  if (refocus) frameButton.focus();
}

on(frameButton, 'click', () => {
  if (!framePanel.hidden) { closeFramePanel(); return; }
  // Asking for Frame is asking for a frame: it comes on as the panel opens,
  // and the switch at its top is there to take it off again.
  if (!frame.on) setFrame({ on: true });
  openFramePanel();
});
on(frameSwitch, 'click', () => setFrame({ on: !frame.on }));
on(framePanel, 'click', event => {
  const swatch = (event.target as Element).closest<HTMLButtonElement>('.background');
  if (swatch?.dataset.background) setFrame({ background: swatch.dataset.background, on: true });
});
for (const input of framePanel.querySelectorAll<HTMLInputElement>('input[data-frame]')) {
  const key = input.dataset.frame as 'padding' | 'radius' | 'shadow' | 'chrome';
  if (input.type === 'checkbox') on(input, 'change', () => setFrame({ chrome: input.checked, on: true }));
  else {
    // Shown as it moves; kept once it is let go.
    on(input, 'input', () => setFrame({ [key]: Number(input.value), on: true }, false));
    on(input, 'change', () => setFrame({ [key]: Number(input.value), on: true }));
  }
}
document.addEventListener('pointerdown', event => {
  const target = event.target as Node;
  if (!framePanel.hidden && !framePanel.contains(target) && !frameButton.contains(target)) closeFramePanel();
}, { signal: abort.signal });
window.addEventListener('resize', () => { if (!framePanel.hidden) placeFramePanel(); }, { signal: abort.signal });
syncFramePanel();

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
function startCapture(mode: CaptureMode) {
  closeCaptureMenu();
  if (!isTauri) { input.click(); return; }
  const call = mode === 'display' ? command('capture_display', {})
    : mode === 'window' ? command('capture_region', { window: true })
    : mode === 'record' ? command('capture_region', { record: true })
    : command('capture_region', mode === 'timed' ? { delay: 5 } : {});
  void call.catch(report);
}

function closeCaptureMenu() {
  captureMenu.hidden = true;
  captureMore.setAttribute('aria-expanded', 'false');
}

/** A small picture of the capture as it stood, drawing and all, so a recent
 *  entry is recognisable at a glance rather than a grey rectangle. Large
 *  enough to fill Recent's 4:3 frames at 2x whatever the capture's shape,
 *  since a wide one is cropped to its height there. */
function thumbnail(source = image, annotations = layer.annotations, density = layer.density): string {
  const width = 240, height = 180;
  const scale = Math.min(1, Math.max(width / (source.naturalWidth || width), height / (source.naturalHeight || height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
  const context = canvas.getContext('2d')!;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  context.scale(scale, scale);
  // The image's own size, which badges are kept inside: the canvas is smaller.
  drawAnnotations(context, annotations, { source, width: source.naturalWidth, height: source.naturalHeight, density });
  return canvas.toDataURL('image/png');
}

/** Hold on to a capture that is leaving the editor. */
function remember(leaving: CapturePreview) {
  if (!image.complete || !image.naturalWidth) return;
  keep({ capture: leaving, thumb: thumbnail(), at: shownAt, annotations: layer.annotations.map(item => ({ ...item })),
         trim: leaving.video && trim ? { ...trim } : undefined });
}

/** Captures copied straight from the overlay, which the editor never showed,
 *  go into Recent all the same. */
async function takeCopied() {
  const copied = await command<CapturePreview[]>('take_copied') ?? [];
  for (const preview of copied) {
    const source = new Image();
    source.src = preview.dataUrl;
    try { await source.decode(); } catch { continue; }
    keep({ capture: preview, thumb: thumbnail(source, [], preview.scale ?? 1), at: Date.now(), annotations: [] });
  }
  if (copied.length) drawRecents();
}

/** Into Recent, newest first, keeping no more than it has room for. */
function keep(entry: Omit<Past, 'id'>) {
  past.unshift({ id: pastId++, ...entry });
  let total = 0;
  for (let index = 0; index < past.length; index++) {
    total += past[index].capture.dataUrl.length;
    if (index >= KEPT || total > KEPT_CHARS) { past.length = Math.max(1, index); break; }
  }
}

/** Bring a kept capture back, drawing and all. Rust no longer holds it, so
 *  copying will go through the flatten path from here on. */
function restore(entry: Past) {
  // Out of Recent while it is back in the editor; it returns to the front of
  // the strip when it leaves again, rather than being there twice.
  past.splice(past.indexOf(entry), 1);
  capture = entry.capture;
  mustFlatten = true;
  crops.length = 0;
  image.src = entry.capture.dataUrl;
  stage.style.setProperty('--ratio', `${entry.capture.width} / ${entry.capture.height}`);
  layer.density = entry.capture.scale ?? 1;
  layer.setImage(entry.capture.width, entry.capture.height);
  layer.load(entry.annotations);
  shown = entry.capture; shownAt = entry.at;
  zoom = startingZoom(entry.capture);
  showMovie(entry.capture, entry.trim);
  render();
}

/** Recent: a strip of the captures themselves, each labelled by when it was
 *  taken. Its size is said to screen readers, and in its tooltip. */
function drawRecents() {
  recents.hidden = !!capture || past.length === 0;
  if (recents.hidden) { recentList.replaceChildren(); return; }
  // More than fit: the next one shows at the edge, and the count says how many.
  recentList.classList.toggle('more', past.length > STRIP);
  recentsCount.textContent = past.length > STRIP ? `${past.length} captures` : '';
  const now = Date.now();
  recentList.replaceChildren(...past.map(entry => {
    const size = `${entry.capture.width} × ${entry.capture.height}`;
    const video = entry.capture.video;
    const length = video ? clock(entry.trim ? entry.trim.end - entry.trim.start : video.duration) : '';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent';
    button.dataset.tip = video ? `Reopen this ${length} recording` : `Reopen this ${size} capture`;
    const thumb = document.createElement('img');
    thumb.src = entry.thumb; thumb.alt = '';
    const when = document.createElement('time');
    when.dateTime = new Date(entry.at).toISOString();
    when.dataset.at = String(entry.at);
    when.textContent = ago(entry.at, now);
    const spoken = document.createElement('span');
    spoken.className = 'sr';
    spoken.textContent = video ? `, a recording ${length} long` : `, ${size}`;
    button.append(thumb, when, spoken);
    if (video) {
      const badge = document.createElement('span');
      badge.className = 'recent-length';
      badge.setAttribute('aria-hidden', 'true');
      badge.innerHTML = `<svg viewBox="0 0 10 10"><path d="M3 2v6l5-3z"/></svg>${length}`;
      button.append(badge);
    }
    button.addEventListener('click', () => restore(entry), { signal: abort.signal });
    return button;
  }));
}

/** "Just now" goes stale while the empty state sits open, so the labels are
 *  brought up to date each half-minute it is on screen. */
const ageing = window.setInterval(() => {
  if (recents.hidden || document.hidden) return;
  const now = Date.now();
  for (const when of recentList.querySelectorAll<HTMLElement>('time')) when.textContent = ago(Number(when.dataset.at), now);
}, 30_000);
cleanups.push(() => window.clearInterval(ageing));
// A mouse wheel scrolls the strip sideways, as a trackpad's swipe does.
recentList.addEventListener('wheel', event => {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || recentList.scrollWidth <= recentList.clientWidth) return;
  event.preventDefault();
  recentList.scrollLeft += event.deltaY;
}, { passive: false, signal: abort.signal });

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
  const dx = Math.round(crop.x), dy = Math.round(crop.y);
  canvas.getContext('2d')!.drawImage(source, dx, dy, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  crops.push({ capture, dx, dy, depth: layer.undoDepth });
  layer.shiftBy(-dx, -dy);
  // A crop keeps the capture's density, so 100% is still its true size after.
  capture = { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, scale: capture.scale };
  mustFlatten = true;
  swapImage(capture);
}

function swapImage(next: CapturePreview) {
  image.src = next.dataUrl;
  stage.style.setProperty('--ratio', `${next.width} / ${next.height}`);
  layer.density = next.scale ?? 1;
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
  if (key === 'escape' && picking) { event.preventDefault(); stopPicking(); return; }
  // An open slot menu owns Escape entirely: it is a popover, and the editor's
  // own Escape would back out of the capture behind it.
  if (key === 'escape' && menuFor) {
    event.preventDefault();
    const button = menuFor;
    closeToolMenu();
    button.focus();
    return;
  }
  if (key === 'escape' && !saveMenu.hidden) {
    event.preventDefault();
    closeSaveMenu(true);
    return;
  }
  if (key === 'escape' && !looksMenu.hidden) {
    event.preventDefault();
    closeLooksMenu(true);
    return;
  }
  if (key === 'escape' && !framePanel.hidden) {
    event.preventDefault();
    closeFramePanel(true);
    return;
  }
  // A text field owns the keys that edit text. Without this, typing a note in
  // the steps panel meant ⌘C copied the screenshot, ⌘V pasted an annotation
  // rather than the clipboard's text -- and having been prevented, never
  // pasted it at all -- ⌘A selected every mark, ⌘Z undid a drawing, and Escape
  // closed the capture. The text tool never had this because its own editing
  // short-circuits above; this is the same courtesy for every other field.
  // ⇧⌘C and ⌥⌘C stay the app's: copying the image is not a text shortcut.
  //
  // ⌘Z is the one with a condition: an empty field has no typing to undo, and
  // a field Mark focused itself the instant a mark was made is exactly where
  // the reflex to take that mark back arrives. With something typed in it, ⌘Z
  // is the typing's again.
  const emptyField = target instanceof HTMLInputElement && target.value === '';
  const fieldKey = key === 'escape'
    || ((event.metaKey || event.ctrlKey)
        && ((key === 'z' && !emptyField)
            || (!event.shiftKey && !event.altKey && ['a', 'c', 'v', 'x'].includes(key))));
  if (typing && fieldKey) return;
  if (capture?.video && !typing && !layer.pendingCrop && videoKey(event, key)) return;
  if (key === 'escape') {
    // Escape backs out one level: the crop, then the selection, then the editor.
    event.preventDefault();
    if (layer.pendingCrop) layer.clearCrop();
    else if (!layer.deselect()) void dismiss().catch(report);
  } else if (event.metaKey && key === 'q') {
    // The app's hidden menu has Quit too, but the demo has no menu to fall back on.
    event.preventDefault(); void command('quit_app').catch(report);
  } else if ((event.metaKey || event.ctrlKey) && key === 'w') {
    event.preventDefault(); void dismiss().catch(report);
  } else if (isTauri && event.metaKey && key === ',') {
    event.preventDefault(); void command('open_settings').catch(report);
  } else if ((event.metaKey || event.ctrlKey) && key === 'a') {
    // Outside a text field ⌘A means marks, even with no capture to hold any:
    // let through, it would reach the Edit menu and select the window's words.
    event.preventDefault();
    if (capture && !layer.selectAll()) flash('Nothing drawn to select.');
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
  } else if (capture && !typing && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
             && SLOTS.some(choices => choices.some(choice => choice.key === key))) {
    // One key a tool. Held down, it picks once rather than spinning through a slot.
    event.preventDefault();
    if (!event.repeat) pickByKey(key);
  } else if (capture && !typing && (key === 'backspace' || key === 'delete')) {
    event.preventDefault(); layer.deleteSelected();
  } else if (capture && key === 'l' && event.shiftKey && (event.metaKey || event.ctrlKey)) {
    event.preventDefault(); void copyList();
  } else if (capture && key === 's' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault(); void exportImage(event.shiftKey ? 'share_image' : 'save_image');
  } else if (capture && key === 't' && event.shiftKey && (event.metaKey || event.ctrlKey)) {
    event.preventDefault(); void copyText();
  } else if (capture && key === 'r' && event.shiftKey && (event.metaKey || event.ctrlKey)) {
    event.preventDefault(); void hideSensitive();
  } else if (capture && (event.metaKey || event.ctrlKey) && event.altKey
             && (event.code === 'KeyC' || key === 'c' || key === 'ç')) {
    // Copy and Close is ⌥⌘C: a copy that also puts the capture away sits one
    // modifier further off than a copy that leaves it open, so the reflex ⌘C
    // never costs the capture. Option turns C into ç on a Mac, so the key is
    // known by where it is as well as by what it types.
    event.preventDefault();
    if (layer.pendingCrop) { flash('Finish or cancel the crop first.'); return; }
    primary();
  } else if (capture && key === 'c' && (event.metaKey || event.ctrlKey)) {
    // ⌘C copies the image and leaves the capture open, as the Copy button says,
    // whatever happens to be selected, and holds the selection for ⌘V besides;
    // ⇧⌘C, which it used to be, still does. ⌘D copies and pastes in one go.
    event.preventDefault();
    if (layer.pendingCrop) { flash('Finish or cancel the crop first.'); return; }
    void copyCapture(false);
  } else if (capture && key === 'v' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    if (!layer.paste().length) flash('Select a mark and copy it with ⌘C first.');
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
  // closed took work. Copying has ⌘C and ⌥⌘C, and Return on the Copy button
  // itself still presses it, because that is what a focused button does.
}, { signal: abort.signal });

/** Everywhere the editor shows a way's shortcut: its tile and its line in the
 *  Capture menu. The settings are the truth; the markup only starts out with
 *  Region's default so the browser preview has one. A way with no shortcut
 *  shows what it has instead -- Timed its delay -- or nothing. */
function showShortcuts(saved: Partial<SavedSettings>) {
  for (const item of CAPTURE_MODES) {
    const chosen = item.mode === 'region' ? saved.shortcut : saved.shortcuts?.[item.mode];
    const text = chosen ? prettyShortcut(chosen) : item.mode === 'region' ? item.hint : item.mode === 'timed' ? '5s' : '';
    for (const key of app.querySelectorAll<HTMLElement>(`[data-start="${item.mode}"] kbd, .capture-menu [data-mode="${item.mode}"] kbd`)) key.textContent = text;
  }
  // The heading's line says the one thing the tiles can't: Mark doesn't have
  // to be open to capture.
  const region = saved.shortcut === undefined ? DEFAULT_SHORTCUT : saved.shortcut;
  restingHint = region ? `Or press ${prettyShortcut(region)} from any app.` : RESTING_HINT;
  if (!request) emptyHint.textContent = restingHint;
}

async function init() {
  if (isTauri) {
    app.querySelector<HTMLElement>('.quit-hint')!.hidden = false;
    const gear = app.querySelector<HTMLButtonElement>('.settings-button')!;
    gear.hidden = false;
    on(gear, 'click', () => { void command('open_settings').catch(report); });
    void command<boolean>('recording_supported').then(can => { recordable = can === true; render(); }).catch(() => {});
    void command<Partial<SavedSettings>>('get_settings').then(saved => {
      frame = sanitizeFrame(saved?.frame); syncFramePanel(); render();
      if (saved) showShortcuts(saved);
    }).catch(() => {});
    cleanups.push(await watchSettings(showShortcuts));
    // The menu's Copy and Close, for a ⌥⌘C that reached the app rather than the
    // page. The page does the copying either way: only it can draw the marks in.
    cleanups.push(await watchMenuCopy(() => {
      if (layer.isEditing) layer.commit();
      if (layer.pendingCrop) { flash('Finish or cancel the crop first.'); return; }
      primary();
    }));
    // The tool that asked gave up before anything was sent. Rust has already
    // taken the ask away; this says why the bar went.
    cleanups.push(await watchRequestWithdrawn(client => flash(`${client} stopped waiting, so nothing was sent.`)));
    cleanups.push(await watchCopied(() => { void takeCopied().catch(report); }));
    void takeCopied().catch(() => {});
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
