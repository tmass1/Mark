import './style.css';
import { command, isTauri, watchCapture, type CapturePreview, type Snapshot } from './platform';
import { copyThenDismiss, type EditorSize } from './model';
import { preferences } from './preferences';
import { sampleCapture } from './sample';
import { AnnotationLayer, COLORS, drawAnnotations, textSize, type Tool } from './annotations';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="titlebar" data-tauri-drag-region>
    <span class="app-title" data-tauri-drag-region>Mark</span>
    <span class="preview-label" hidden>Browser preview</span>
  </header>
  <div class="toolbar" role="toolbar" aria-label="Annotation tools" hidden>
    <div class="tools" role="radiogroup" aria-label="Tool">
      <button class="tool" type="button" role="radio" data-tool="arrow" aria-checked="true">Arrow</button>
      <button class="tool" type="button" role="radio" data-tool="text" aria-checked="false">Text</button>
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
    </section>
  </main>
  <aside class="message" role="status" aria-live="polite" hidden><span></span><button class="settings" hidden>Open System Settings</button></aside>
  <footer>
    <span class="dimensions" aria-label="Image dimensions"></span>
    <button class="choose subtle" type="button" hidden>Choose image…</button>
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
const start = app.querySelector<HTMLButtonElement>('.start')!;
const choose = app.querySelector<HTMLButtonElement>('.choose')!;
const input = app.querySelector<HTMLInputElement>('.file-input')!;
const message = app.querySelector<HTMLElement>('.message')!;
const settings = app.querySelector<HTMLButtonElement>('.settings')!;
const abort = new AbortController();
const cleanups: (() => void)[] = [];
let capture: CapturePreview | null = null;
let busy = false;
let copyPending = false;
let disposed = false;

const layer = new AnnotationLayer(overlay, stage, () => syncTools());

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
    layer.style.scale = selected.kind === 'arrow'
      ? selected.weight / layer.base
      : selected.size / textSize(layer.base);
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
  undoButton.disabled = !layer.canUndo;
  removeButton.disabled = layer.selected === null || layer.isEditing;
}

function render() {
  stage.hidden = !capture;
  toolbar.hidden = !capture;
  empty.hidden = !!capture;
  if (capture) {
    // A different image means a different drawing surface; arrows never carry over.
    if (image.getAttribute('src') !== capture.dataUrl) {
      image.src = capture.dataUrl;
      stage.style.setProperty('--ratio', `${capture.width} / ${capture.height}`);
      layer.setImage(capture.width, capture.height);
    }
    image.alt = `Captured screenshot, ${capture.width} by ${capture.height} pixels`;
  } else image.removeAttribute('src');
  app.querySelector('.dimensions')!.textContent = capture ? `${capture.width} × ${capture.height} px` : '';
  copy.hidden = !capture;
  copy.disabled = busy || copyPending;
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
  drawAnnotations(context, layer.annotations);
  return canvas;
}

async function copyCapture() {
  if (!capture || busy || copyPending) return;
  copyPending = true; render(); showMessage(null);
  try {
    if (isTauri) {
      // An untouched capture keeps its original bytes; only a drawing re-encodes.
      if (layer.empty) await command('copy_and_close');
      else await command('copy_annotated_and_close', { png: (await flatten()).toDataURL('image/png').split(',')[1] });
      capture = null;
    } else {
      // Start clipboard.write inside the gesture; Safari accepts a promised Blob.
      const png = layer.empty
        ? fetch(capture.dataUrl).then(response => response.blob())
        : flatten().then(canvas => new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('The image could not be encoded.'))), 'image/png')));
      await copyThenDismiss(async () => {
        if (!navigator.clipboard?.write) throw new Error('Image copying needs clipboard access on localhost or HTTPS.');
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      }, () => { capture = null; });
      showMessage('Copied to clipboard.');
    }
  } catch (error) { report(error); }
  finally { copyPending = false; render(); }
}

function on<K extends keyof HTMLElementEventMap>(element: HTMLElement, name: K, handler: (event: HTMLElementEventMap[K]) => void) {
  element.addEventListener(name, handler, { signal: abort.signal });
}
on(copy, 'click', () => { void copyCapture(); });
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
on(undoButton, 'click', () => { layer.undo(); });
on(removeButton, 'click', () => { layer.deleteSelected(); });

// The overlay scales with the window; handles are sized from the drawn width.
const observer = new ResizeObserver(() => layer.measure());
observer.observe(stage);
cleanups.push(() => observer.disconnect());

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
    // Escape backs out one level: first the selection, then the editor.
    event.preventDefault();
    if (!layer.deselect()) void dismiss().catch(report);
  } else if ((event.metaKey || event.ctrlKey) && key === 'w') {
    event.preventDefault(); void dismiss().catch(report);
  } else if (capture && (event.metaKey || event.ctrlKey) && key === 'z') {
    event.preventDefault(); layer.undo();
  } else if (capture && !typing && (key === 'backspace' || key === 'delete')) {
    event.preventDefault(); layer.deleteSelected();
  } else if (capture && ((key === 'c' && (event.metaKey || event.ctrlKey)) ||
      (key === 'enter' && (document.activeElement === document.body || document.activeElement === copy)))) {
    event.preventDefault(); void copyCapture();
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
