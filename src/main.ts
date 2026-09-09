import './style.css';
import { command, isTauri, watchCapture, type CapturePreview, type Snapshot } from './platform';
import { copyThenDismiss, type EditorSize } from './model';
import { preferences } from './preferences';
import { sampleCapture } from './sample';
import { AnnotationLayer, COLORS, describe, drawAnnotations, textSize, type Tool } from './annotations';

/** Six tools do not fit as words, so the palette is glyphs with real labels
 *  behind them for screen readers and tooltips. */
const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
const TOOLS: { id: Tool; name: string; art: string }[] = [
  { id: 'arrow', name: 'Arrow', art: `<path d="M5.5 14.5 14 6M5.5 14.5h5.2M5.5 14.5V9.3" ${STROKE}/>` },
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
    <button class="undo subtle" type="button" title="Undo (⌘Z)">Undo</button>
    <button class="remove subtle" type="button" title="Delete selection (⌫)">Delete</button>
  </div>
  <main class="canvas" aria-label="Screenshot editor">
    <div class="stage" hidden>
      <img class="capture" alt="Captured screenshot" draggable="false" />
      <svg class="overlay" xmlns="http://www.w3.org/2000/svg" role="group" aria-label="Arrow annotations"></svg>
    </div>
    <section class="empty" hidden>
      <svg class="viewfinder" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M12 5H7a2 2 0 0 0-2 2v5m15-7h5a2 2 0 0 1 2 2v5M5 20v5a2 2 0 0 0 2 2h5m15-7v5a2 2 0 0 1-2 2h-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <h1>Capture a region</h1><p class="empty-hint">A little less between seeing and sharing.</p>
      <button class="start primary" type="button">Capture Region <kbd>⌃⌥⌘4</kbd></button>
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
    <button class="choose subtle" type="button" hidden>Choose image…</button>
    <button class="copy-only subtle" type="button" title="Copy the image and keep working">Copy <kbd>⌘⇧C</kbd></button>
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
const removeButton = app.querySelector<HTMLButtonElement>('.remove')!;
const empty = app.querySelector<HTMLElement>('.empty')!;
const copy = app.querySelector<HTMLButtonElement>('.copy')!;
const copyOnly = app.querySelector<HTMLButtonElement>('.copy-only')!;
const start = app.querySelector<HTMLButtonElement>('.start')!;
const choose = app.querySelector<HTMLButtonElement>('.choose')!;
const input = app.querySelector<HTMLInputElement>('.file-input')!;
const message = app.querySelector<HTMLElement>('.message')!;
const settings = app.querySelector<HTMLButtonElement>('.settings')!;
const cropBar = app.querySelector<HTMLElement>('.crop-bar')!;
const cropSize = app.querySelector<HTMLElement>('.crop-size')!;
const abort = new AbortController();
const cleanups: (() => void)[] = [];
let capture: CapturePreview | null = null;
let busy = false;
let copyPending = false;
let disposed = false;
let shown: CapturePreview | null = null;
let cropped = false;
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
  const selected = layer.annotations.find(item => item.id === layer.selected);
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
  overlay.classList.toggle('draw-tool', layer.tool !== 'arrow' && layer.tool !== 'text');
  overlay.classList.toggle('crop-tool', layer.tool === 'crop');
  const crop = layer.pendingCrop;
  cropBar.hidden = !crop;
  if (crop) cropSize.textContent = `Crop to ${Math.round(crop.width)} × ${Math.round(crop.height)} px`;
  undoButton.disabled = !layer.canUndo && !crops.length;
  removeButton.disabled = layer.selected === null || layer.isEditing;
}

function render() {
  stage.hidden = !capture;
  toolbar.hidden = !capture;
  empty.hidden = !!capture;
  if (capture) {
    // A different capture means a different drawing surface. A crop swaps the
    // image in place and updates `shown` itself, so it is not mistaken for one.
    if (capture !== shown) {
      image.src = capture.dataUrl;
      stage.style.setProperty('--ratio', `${capture.width} / ${capture.height}`);
      layer.setImage(capture.width, capture.height);
      shown = capture; cropped = false; crops.length = 0;
    }
    image.alt = `Captured screenshot, ${capture.width} by ${capture.height} pixels`;
  } else image.removeAttribute('src');
  app.querySelector('.dimensions')!.textContent = capture ? `${capture.width} × ${capture.height} px` : '';
  copy.hidden = !capture;
  copyOnly.hidden = !capture;
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

async function copyCapture(close = true) {
  if (!capture || busy || copyPending) return;
  copyPending = true; render(); showMessage(null);
  try {
    if (isTauri) {
      // An untouched capture keeps its original bytes; only a drawing re-encodes.
      // A crop makes the original bytes wrong, so it forces a re-encode too.
      if (layer.empty && !cropped) await command('copy_capture', { close });
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
on(start, 'click', () => {
  if (!isTauri) { input.click(); return; }
  void command('capture_region').catch(report);
});
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

// The overlay scales with the window; handles are sized from the drawn width.
const observer = new ResizeObserver(() => layer.measure());
observer.observe(stage);
cleanups.push(() => observer.disconnect());

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
  cropped = true;
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
    cropped = crops.length > 0;
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
  } else if (capture && (event.metaKey || event.ctrlKey) && key === 'z') {
    event.preventDefault(); stepBack();
  } else if (capture && !typing && (key === 'backspace' || key === 'delete')) {
    event.preventDefault(); layer.deleteSelected();
  } else if (capture && key === 'c' && event.shiftKey && (event.metaKey || event.ctrlKey)) {
    event.preventDefault(); void copyCapture(false);
  } else if (capture && key === 'c' && (event.metaKey || event.ctrlKey)) {
    // With something selected this copies that, not the screenshot. Say so, so
    // the change of meaning is never silent.
    event.preventDefault();
    if (layer.pendingCrop) { flash('Finish or cancel the crop first.'); return; }
    const taken = layer.copySelection();
    if (taken) flash(`${describe(taken.kind)} copied. ⌘V pastes it, Escape deselects.`);
    else void copyCapture(true);
  } else if (capture && key === 'v' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    if (!layer.paste()) flash('Copy an arrow, note or shape first.');
  } else if (capture && key === 'd' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    if (!layer.duplicateSelection()) flash('Select something to duplicate.');
  } else if (capture && key === 'enter' && layer.pendingCrop) {
    event.preventDefault(); void applyCrop().catch(report);
  } else if (capture && key === 'enter' &&
      (document.activeElement === document.body || document.activeElement === copy)) {
    event.preventDefault(); void copyCapture(true);
  }
}, { signal: abort.signal });

async function installPreferences() {
  const store = await preferences();
  let lastSize = await store.getSize();
  let applying = false;
  const applySize = async (size: EditorSize | null) => {
    if (!size || disposed) return;
    lastSize = size;
    if (isTauri) {
      const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window');
      applying = true;
      try { await getCurrentWindow().setSize(new LogicalSize(Math.min(size.width, screen.availWidth), Math.min(size.height, screen.availHeight))); }
      finally { applying = false; }
    }
  };
  // Subscribe before reading again so another window's update cannot get lost.
  const unsubscribe = await store.onSizeChange(size => {
    if (size?.width !== lastSize?.width || size?.height !== lastSize?.height) void applySize(size).catch(report);
  });
  if (disposed) { unsubscribe(); return; }
  cleanups.push(unsubscribe);
  await applySize(await store.getSize());
  let timer: ReturnType<typeof setTimeout>;
  const remember = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (applying || disposed) return;
      const size = { width: window.innerWidth, height: window.innerHeight };
      if (size.width === lastSize?.width && size.height === lastSize?.height) return;
      lastSize = size;
      void store.setSize(size).catch(report);
    }, 180);
  };
  window.addEventListener('resize', remember, { signal: abort.signal });
  cleanups.push(() => clearTimeout(timer));
}

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
  await installPreferences();
}
render();
void init().catch(report);
import.meta.hot?.dispose(() => { disposed = true; abort.abort(); cleanups.forEach(cleanup => cleanup()); });
