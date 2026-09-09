import './style.css';
import { command, isTauri, watchCapture, type CapturePreview, type Snapshot } from './platform';
import { copyThenDismiss } from './model';
import { sampleCapture } from './sample';
import { AnnotationLayer, COLORS, arrowPolygon, describe, drawAnnotations, polygonPath, textSize,
         type Annotation, type Tool } from './annotations';

/** The app's mark: the same arrow the icon is built from, and the same function
 *  every arrow in the editor comes out of, so the empty state cannot drift away
 *  from what is in the Dock. */
const MARK_ARROW = polygonPath(arrowPolygon(
  { kind: 'arrow', id: 0, x1: 792, y1: 232, x2: 322, y2: 702, color: '', weight: 74 }));
const MARK_FRAME = 'M258 396V308a50 50 0 0 1 50-50h88M628 258h88a50 50 0 0 1 50 50v88'
  + 'M766 628v88a50 50 0 0 1-50 50h-88M396 766h-88a50 50 0 0 1-50-50v-88';

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
  { mode: 'region', name: 'Region', hint: '⌃⌥⌘4', art:
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

const TOOLS: { id: Tool; name: string; art: string }[] = [
  { id: 'arrow', name: 'Arrow', art: `<path d="M5.5 14.5 14 6M5.5 14.5h5.2M5.5 14.5V9.3" ${STROKE}/>` },
  { id: 'line', name: 'Line', art: `<path d="M5.4 14.6 14.6 5.4" ${STROKE}/>` },
  { id: 'pen', name: 'Pen', art:
    `<path d="M4.2 13.8c1.9-4.6 3.2 2.3 5.1-1.1s2.9 3 4.4-1.2 1.4 2 2.1.9" ${STROKE}/>` },
  { id: 'text', name: 'Text', art: `<path d="M5 6h10M10 6v8.5M7.8 14.5h4.4" ${STROKE}/>` },
  { id: 'box', name: 'Box', art: `<rect x="4.6" y="5.8" width="10.8" height="8.4" rx="1.4" ${STROKE}/>` },
  { id: 'ellipse', name: 'Ellipse', art: `<ellipse cx="10" cy="10" rx="5.6" ry="4.4" ${STROKE}/>` },
  { id: 'highlight', name: 'Highlighter', art:
    `<path d="M4.6 15.6h10.8" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" opacity=".45"/>` +
    `<path d="M6.9 12.4 12.4 6.9l2 2-5.5 5.5z" ${STROKE}/>` },
  { id: 'crop', name: 'Crop', art:
    `<path d="M6.6 2.8v10.6h10.6M2.8 6.6h10.6v10.6" ${STROKE}/>` },
  { id: 'redact', name: 'Redact', art:
    `<path d="M4.8 5.2h4.1v4.1H4.8zM11.1 5.2h4.1v4.1h-4.1zM4.8 10.7h4.1v4.1H4.8zM11.1 10.7h4.1v4.1h-4.1z" fill="currentColor"/>` },
];

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="titlebar" data-tauri-drag-region>
    <span class="app-title" data-tauri-drag-region>Mark</span>
    <span class="preview-label" hidden>Browser preview</span>
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
    <div class="tools" role="radiogroup" aria-label="Tool">
      ${TOOLS.map(tool => `<button class="tool" type="button" role="radio" data-tool="${tool.id}"
        aria-checked="${tool.id === 'arrow'}" title="${tool.name}"><svg viewBox="0 0 20 20" aria-hidden="true">${tool.art}</svg><span class="sr">${tool.name}</span></button>`).join('')}
    </div>
    <div class="swatches" role="radiogroup" aria-label="Color">
      ${COLORS.map(color => `<button class="swatch" type="button" role="radio" aria-checked="false"
        data-color="${color.value}" style="--swatch:${color.value}" title="${color.name}"><span class="sr">${color.name}</span></button>`).join('')}
    </div>
    <label class="size">Size
      <input class="weight" type="range" min="0.5" max="2.5" step="0.1" value="1" aria-label="Size" />
    </label>
    <span class="spacer"></span>
    <span class="chosen" hidden aria-live="polite"></span>
    <button class="back subtle icon" type="button" title="Send backward (⌘[)" aria-label="Send backward">
      <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.2" y="3.2" width="9" height="9" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 15.2a1.6 1.6 0 0 0 1.6 1.6h5.6a1.6 1.6 0 0 0 1.6-1.6V9.6A1.6 1.6 0 0 0 15.2 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </button>
    <button class="front subtle icon" type="button" title="Bring forward (⌘])" aria-label="Bring forward">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12 4.8a1.6 1.6 0 0 0-1.6-1.6H4.8A1.6 1.6 0 0 0 3.2 4.8v5.6A1.6 1.6 0 0 0 4.8 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><rect x="7.8" y="7.8" width="9" height="9" rx="1.6" fill="currentColor" opacity=".9"/></svg>
    </button>
    <button class="undo subtle" type="button" title="Undo (⌘Z)">Undo</button>
    <button class="remove subtle" type="button" title="Delete selection (⌫)">Delete</button>
  </div>
  <main class="canvas" aria-label="Screenshot editor">
    <div class="stage" hidden>
      <img class="capture" alt="Captured screenshot" draggable="false" />
      <svg class="overlay" xmlns="http://www.w3.org/2000/svg" role="group" aria-label="Arrow annotations"></svg>
    </div>
    <section class="empty" hidden>
      <svg class="viewfinder" viewBox="0 0 1024 1024" aria-hidden="true">
        <path d="${MARK_FRAME}" fill="none" stroke="currentColor" stroke-width="52" stroke-linecap="round" stroke-linejoin="round" opacity=".38"/>
        <path d="${MARK_ARROW}" fill="var(--brand)"/>
      </svg>
      <h1>Capture a region</h1><p class="empty-hint">A little less between seeing and sharing.</p>
      <button class="start primary" type="button">Capture Region <kbd>⌃⌥⌘4</kbd></button>
      <section class="recents" hidden aria-label="Recent captures">
        <p class="recents-label">Recent</p>
        <div class="recent-list"></div>
      </section>
      <p class="quit-hint" hidden>Mark lives in the menu bar · ⌘W hides it · ⌘Q quits</p>
    </section>
  </main>
  <aside class="message" role="status" aria-live="polite" hidden><span></span><button class="settings" hidden>Open System Settings</button></aside>
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
    <button class="copy-only glassy" type="button" title="Copy the image and keep working">Copy <kbd>⌘⇧C</kbd></button>
    <button class="copy primary" type="button">Copy and Close <kbd>⌘C</kbd></button>
  </footer>
  <input class="file-input" type="file" accept="image/png,image/jpeg,image/webp" hidden />
`;
const image = app.querySelector<HTMLImageElement>('.capture')!;
const stage = app.querySelector<HTMLElement>('.stage')!;
const overlay = app.querySelector<SVGSVGElement>('.overlay')!;
const toolbar = app.querySelector<HTMLElement>('.toolbar')!;
const weight = app.querySelector<HTMLInputElement>('.weight')!;
const undoButton = app.querySelector<HTMLButtonElement>('.undo')!;
const backButton = app.querySelector<HTMLButtonElement>('.back')!;
const frontButton = app.querySelector<HTMLButtonElement>('.front')!;
const chosenCount = app.querySelector<HTMLElement>('.chosen')!;
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

const layer = new AnnotationLayer(overlay, stage, () => syncTools());
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
function syncTools() {
  const picked = layer.selection;
  // Say what a colour or size change is about to land on. Restyling the thing
  // just drawn is right, but it should never be a surprise.
  chosenCount.hidden = picked.length === 0;
  chosenCount.textContent = picked.length === 1
    ? `${describe(picked[0].kind)} selected`
    : `${picked.length} selected`;
  const selected = layer.styleSource;
  if (selected) {
    layer.style.color = selected.color;
    layer.style.scale = selected.kind === 'text'
      ? selected.size / textSize(layer.base)
      : selected.weight / layer.base;
  }
  weight.value = layer.style.scale.toFixed(1);
  for (const swatch of app.querySelectorAll<HTMLButtonElement>('.swatch')) {
    const active = swatch.dataset.color === layer.style.color;
    swatch.setAttribute('aria-checked', String(active));
    swatch.classList.toggle('active', active);
  }
  for (const button of app.querySelectorAll<HTMLButtonElement>('.tool')) {
    const active = button.dataset.tool === layer.tool;
    button.setAttribute('aria-checked', String(active));
    button.classList.toggle('active', active);
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
}

function render() {
  stage.hidden = !capture;
  toolbar.hidden = !capture;
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
  drawAnnotations(context, layer.annotations, source);
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
      if (close) capture = null; else flash('Copied to clipboard.');
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
      flash('Copied to clipboard.');
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
on(toolbar, 'click', event => {
  const element = event.target as Element;
  const tool = element.closest<HTMLButtonElement>('.tool');
  if (tool?.dataset.tool) { layer.tool = tool.dataset.tool as Tool; layer.deselect(); syncTools(); return; }
  const swatch = element.closest<HTMLButtonElement>('.swatch');
  if (!swatch?.dataset.color) return;
  layer.style.color = swatch.dataset.color;
  layer.applyStyle();
});
on(weight, 'input', () => { layer.style.scale = Number(weight.value); layer.applyStyle(); });
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
  drawAnnotations(context, layer.annotations, image);
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
  } else if (capture && key === 's' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault(); void exportImage(event.shiftKey ? 'share_image' : 'save_image');
  } else if (capture && key === 'c' && event.shiftKey && (event.metaKey || event.ctrlKey)) {
    event.preventDefault(); void copyCapture(false);
  } else if (capture && key === 'c' && (event.metaKey || event.ctrlKey)) {
    // With something selected this copies that, not the screenshot. Say so, so
    // the change of meaning is never silent.
    event.preventDefault();
    if (layer.pendingCrop) { flash('Finish or cancel the crop first.'); return; }
    const taken = layer.copySelection();
    if (taken.length === 1) flash(`${describe(taken[0].kind)} copied. ⌘V pastes it, Escape deselects.`);
    else if (taken.length) flash(`${taken.length} annotations copied. ⌘V pastes them.`);
    else void copyCapture(true);
  } else if (capture && key === 'v' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    if (!layer.paste().length) flash('Copy an arrow, note or shape first.');
  } else if (capture && key === 'd' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    if (!layer.duplicateSelection().length) flash('Select something to duplicate.');
  } else if (capture && key === 'enter' && layer.pendingCrop) {
    event.preventDefault(); void applyCrop().catch(report);
  } else if (capture && key === 'enter' &&
      (document.activeElement === document.body || document.activeElement === copy)) {
    event.preventDefault(); void copyCapture(true);
  }
}, { signal: abort.signal });

async function init() {
  if (isTauri) {
    app.querySelector<HTMLElement>('.quit-hint')!.hidden = false;
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
