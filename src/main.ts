import './style.css';
import { command, isTauri, watchCapture, type CapturePreview, type Snapshot } from './platform';
import { copyThenDismiss, type EditorSize } from './model';
import { preferences } from './preferences';
import { sampleCapture } from './sample';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="titlebar" data-tauri-drag-region>
    <span class="app-title" data-tauri-drag-region>Mark</span>
    <span class="preview-label" hidden>Browser preview</span>
  </header>
  <main class="canvas" aria-label="Screenshot editor">
    <img class="capture" alt="Captured screenshot" draggable="false" hidden />
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

function showMessage(text: string | null) {
  message.hidden = !text;
  message.querySelector('span')!.textContent = text ?? '';
  settings.hidden = !isTauri || !text?.includes('screen access');
}

function render() {
  image.hidden = !capture;
  empty.hidden = !!capture;
  if (capture) {
    if (image.getAttribute('src') !== capture.dataUrl) image.src = capture.dataUrl;
    image.alt = `Captured screenshot, ${capture.width} by ${capture.height} pixels`;
  } else image.removeAttribute('src');
  app.querySelector('.dimensions')!.textContent = capture ? `${capture.width} × ${capture.height} px` : '';
  copy.hidden = !capture;
  copy.disabled = busy || copyPending;
  start.disabled = busy;
  start.firstChild!.textContent = isTauri ? (busy ? 'Selecting… ' : 'Capture Region ') : 'Choose image… ';
  start.querySelector('kbd')!.hidden = !isTauri;
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

async function copyCapture() {
  if (!capture || busy || copyPending) return;
  copyPending = true; render(); showMessage(null);
  try {
    if (isTauri) {
      await command('copy_and_close'); capture = null;
    } else {
      // Start clipboard.write inside the gesture; Safari accepts a promised Blob.
      const png = fetch(capture.dataUrl).then(response => response.blob());
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
  if (key === 'escape' || ((event.metaKey || event.ctrlKey) && key === 'w')) {
    event.preventDefault(); void dismiss().catch(report);
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
