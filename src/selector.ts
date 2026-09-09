import './selector.css';
import { clampRect, fitRatio, type Rect } from './region';

/** Injected per window by Rust: where this display starts in the global point
 *  space that screencapture -R also uses, and how big it is. */
declare global {
  interface Window {
    __MARK_DISPLAY__?: { x: number; y: number; width: number; height: number; scale: number };
    /** A delay chosen before the overlay opened, from Capture's menu. */
    __MARK_DELAY__?: number;
  }
}
const display = window.__MARK_DISPLAY__ ?? { x: 0, y: 0, width: innerWidth, height: innerHeight, scale: 1 };
const inTauri = '__TAURI_INTERNALS__' in window;
const DELAYS = [0, 3, 5, 10];

const root = document.querySelector<HTMLDivElement>('#selector')!;
root.innerHTML = `
  <div class="veil"></div>
  <div class="shot" hidden>
    ${['nw', 'ne', 'se', 'sw'].map(corner => `<span class="grip ${corner}" data-grip="${corner}"></span>`).join('')}
  </div>
  <div class="readout" hidden></div>
  <div class="hint">Drag to select a region · Escape to cancel</div>
  <div class="panel" hidden>
    <label class="field">Width <input class="w" type="number" min="1" step="1" /></label>
    <label class="field">Height <input class="h" type="number" min="1" step="1" /></label>
    <button class="lock icon" type="button" aria-pressed="false" aria-label="Lock the ratio" title="Lock the ratio">
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <path d="M7.4 10h5.2M8.6 6.6H6.4a3.4 3.4 0 0 0 0 6.8h2.2M11.4 6.6h2.2a3.4 3.4 0 0 1 0 6.8h-2.2"/></svg>
    </button>
    <span class="gap"></span>
    <button class="cancel" type="button">Cancel</button>
    <button class="delay icon" type="button" aria-label="Capture after a delay" title="Capture after a delay">
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="10" cy="10.5" r="6.6"/><path d="M10 6.6v4l2.6 1.7"/><path d="M7.6 2.6h4.8"/></svg>
    </button>
    <button class="full icon" type="button" aria-label="Whole display" title="Whole display">
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <path d="M4 8V5.2A1.2 1.2 0 0 1 5.2 4H8M12 4h2.8A1.2 1.2 0 0 1 16 5.2V8M16 12v2.8a1.2 1.2 0 0 1-1.2 1.2H12M8 16H5.2A1.2 1.2 0 0 1 4 14.8V12"/></svg>
    </button>
    <button class="go" type="button">Capture</button>
  </div>
`;
const veil = root.querySelector<HTMLElement>('.veil')!;
const shot = root.querySelector<HTMLElement>('.shot')!;
const readout = root.querySelector<HTMLElement>('.readout')!;
const hint = root.querySelector<HTMLElement>('.hint')!;
const panel = root.querySelector<HTMLElement>('.panel')!;
const widthField = root.querySelector<HTMLInputElement>('.w')!;
const heightField = root.querySelector<HTMLInputElement>('.h')!;
const lock = root.querySelector<HTMLButtonElement>('.lock')!;
const delayButton = root.querySelector<HTMLButtonElement>('.delay')!;

let rect: Rect | null = null;
let ratio = 1;
let locked = false;
// Guard the injected value, but keep the coalesced one: testing `?? 0` and then
// assigning the raw field left delay undefined whenever nothing was injected,
// which is the ordinary case, and indexOf(undefined) cycles straight back to 0.
const armed = window.__MARK_DELAY__ ?? 0;
let delay = DELAYS.includes(armed) ? armed : 0;
let drag: { kind: 'new' | 'move' | 'grip'; grip?: string; ox: number; oy: number; from: Rect } | null = null;
let sent = false;

async function invoke(command: string, args?: Record<string, unknown>) {
  if (!inTauri) { console.info('[Mark selector]', command, args); return; }
  const { invoke: call } = await import('@tauri-apps/api/core');
  await call(command, args);
}

async function announce() {
  if (!inTauri) return;
  const { emit } = await import('@tauri-apps/api/event');
  await emit('selection-started', {});
}

function show() {
  const has = rect !== null && rect.width >= 1 && rect.height >= 1;
  veil.hidden = has;
  shot.hidden = !has;
  hint.hidden = has || drag !== null;
  panel.hidden = !has || drag !== null;
  readout.hidden = !has || drag === null;
  if (!rect) return;
  Object.assign(shot.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  const w = Math.round(rect.width), h = Math.round(rect.height);
  readout.textContent = `${w} × ${h}`;
  Object.assign(readout.style, {
    left: `${Math.min(Math.max(rect.x, 6), innerWidth - 110)}px`,
    top: `${rect.y > 30 ? rect.y - 27 : rect.y + rect.height + 8}px`,
  });
  if (document.activeElement !== widthField) widthField.value = String(w);
  if (document.activeElement !== heightField) heightField.value = String(h);
  if (!panel.hidden) placePanel();
}

/** Below the selection when there is room, above it otherwise, and inside as a
 *  last resort on a very tall selection. */
function placePanel() {
  if (!rect) return;
  const box = panel.getBoundingClientRect();
  const left = Math.min(Math.max(rect.x + rect.width / 2 - box.width / 2, 8), innerWidth - box.width - 8);
  const below = rect.y + rect.height + 10;
  const above = rect.y - box.height - 10;
  const top = below + box.height <= innerHeight - 8 ? below
            : above >= 8 ? above
            : Math.max(8, rect.y + rect.height - box.height - 10);
  Object.assign(panel.style, { left: `${left}px`, top: `${top}px` });
}

function setRect(next: Rect | null) {
  rect = next && clampRect(next, display.width, display.height);
  show();
}

function point(event: PointerEvent): [number, number] { return [event.clientX, event.clientY]; }

root.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  const target = event.target as Element;
  if (target.closest('.panel')) return;              // the panel handles its own clicks
  event.preventDefault();
  root.setPointerCapture(event.pointerId);
  const [x, y] = point(event);
  const grip = target.getAttribute('data-grip');
  if (grip && rect) drag = { kind: 'grip', grip, ox: x, oy: y, from: { ...rect } };
  else if (target.closest('.shot') && rect) drag = { kind: 'move', ox: x, oy: y, from: { ...rect } };
  else {
    drag = { kind: 'new', ox: x, oy: y, from: { x, y, width: 0, height: 0 } };
    setRect({ x, y, width: 0, height: 0 });
    void announce();
  }
  show();
});

root.addEventListener('pointermove', event => {
  if (!drag) return;
  const [x, y] = point(event);
  const from = drag.from;
  if (drag.kind === 'new') {
    setRect({ x: Math.min(from.x, x), y: Math.min(from.y, y), width: Math.abs(x - from.x), height: Math.abs(y - from.y) });
  } else if (drag.kind === 'move') {
    setRect({ ...from, x: from.x + (x - drag.ox), y: from.y + (y - drag.oy) });
  } else {
    const west = drag.grip === 'nw' || drag.grip === 'sw';
    const north = drag.grip === 'nw' || drag.grip === 'ne';
    const anchorX = west ? from.x + from.width : from.x;
    const anchorY = north ? from.y + from.height : from.y;
    let width = Math.abs(x - anchorX), height = Math.abs(y - anchorY);
    if (locked) ({ width, height } = fitRatio(width, height, ratio));
    setRect({ x: Math.min(anchorX, west ? anchorX - width : anchorX + width),
              y: Math.min(anchorY, north ? anchorY - height : anchorY + height), width, height });
  }
});

root.addEventListener('pointerup', event => {
  if (!drag) return;
  const started = drag.kind === 'new';
  drag = null;
  if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
  // A click with no drag is not a region; go back to an empty screen.
  if (started && rect && (rect.width < 6 || rect.height < 6)) rect = null;
  if (rect) ratio = rect.width / Math.max(rect.height, 1);
  show();
});

function resize(width: number, height: number) {
  if (!rect || !Number.isFinite(width) || !Number.isFinite(height)) return;
  setRect({ ...rect, width: Math.max(1, width), height: Math.max(1, height) });
}
widthField.addEventListener('input', () => {
  const width = Number(widthField.value);
  resize(width, locked ? width / ratio : rect?.height ?? 0);
});
heightField.addEventListener('input', () => {
  const height = Number(heightField.value);
  resize(locked ? height * ratio : rect?.width ?? 0, height);
});
lock.addEventListener('click', () => {
  locked = !locked;
  lock.setAttribute('aria-pressed', String(locked));
  if (locked && rect) ratio = rect.width / Math.max(rect.height, 1);
});
function showDelay() {
  delayButton.classList.toggle('armed', delay > 0);
  delayButton.title = delay ? `Capture ${delay} seconds after you press Capture` : 'Capture after a delay';
  const label = delayButton.querySelector('.delay-label');
  if (delay) {
    if (label) label.textContent = `${delay}s`;
    else delayButton.insertAdjacentHTML('beforeend', `<span class="delay-label">${delay}s</span>`);
  } else label?.remove();
}
delayButton.addEventListener('click', () => {
  delay = DELAYS[(DELAYS.indexOf(delay) + 1) % DELAYS.length];
  showDelay();
});
showDelay();
root.querySelector('.full')!.addEventListener('click', () => {
  setRect({ x: 0, y: 0, width: display.width, height: display.height });
});
root.querySelector('.cancel')!.addEventListener('click', () => void cancel());
root.querySelector('.go')!.addEventListener('click', () => void capture());

async function capture() {
  if (!rect || sent) return;
  const { x, y, width, height } = rect;
  if (width < 1 || height < 1) return;
  sent = true;
  await invoke('capture_rect', {
    x: display.x + x, y: display.y + y, width, height, delay,
  }).catch(error => { sent = false; console.error('[Mark]', error); });
}
async function cancel() {
  if (sent) return;
  sent = true;
  await invoke('cancel_selection').catch(error => { sent = false; console.error('[Mark]', error); });
}

document.addEventListener('keydown', event => {
  const typing = (event.target as HTMLElement)?.tagName === 'INPUT';
  if (event.key === 'Escape') { event.preventDefault(); void cancel(); }
  else if (event.key === 'Enter') {
    event.preventDefault();
    if (typing) (event.target as HTMLInputElement).blur(); else void capture();
  } else if (!typing && event.key === 'a' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    setRect({ x: 0, y: 0, width: display.width, height: display.height });
  }
});

// Only one display may hold the selection, so a drag here clears the others.
if (inTauri) {
  void import('@tauri-apps/api/event').then(({ listen }) =>
    listen('selection-started', () => { if (!drag) { rect = null; show(); } }));
}
show();
