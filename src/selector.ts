import './selector.css';
import { clampRect, fitRatio, type Rect } from './region';

/** A window on screen when the overlay opened, in global points. */
interface ScreenWindow { id: number; app: string; title: string; x: number; y: number; width: number; height: number }
type Mode = 'region' | 'window';

/** Injected per window by Rust: where this display starts in the global point
 *  space that screencapture -R also uses, and how big it is. */
declare global {
  interface Window {
    __MARK_DISPLAY__?: { x: number; y: number; width: number; height: number; scale: number };
    /** A delay chosen before the overlay opened, from Capture's menu. */
    __MARK_DELAY__?: number;
    /** The windows that can be picked, front to back, in the same points. */
    __MARK_WINDOWS__?: ScreenWindow[];
    /** Window when Capture Window opened the overlay; a region otherwise. */
    __MARK_MODE__?: Mode;
    /** Where the pointer was as the overlay opened, in global points. */
    __MARK_POINTER__?: { x: number; y: number } | null;
    /** "video" when what is picked is to be recorded rather than captured. */
    __MARK_KIND__?: 'shot' | 'video';
    /** For a recording, whether the microphone was on last time. */
    __MARK_MIC__?: boolean;
  }
}
const display = window.__MARK_DISPLAY__ ?? { x: 0, y: 0, width: innerWidth, height: innerHeight, scale: 1 };
const inTauri = '__TAURI_INTERNALS__' in window;
const DELAYS = [0, 3, 5, 10];
const windows = (window.__MARK_WINDOWS__ ?? []).filter(w => [w.x, w.y, w.width, w.height].every(Number.isFinite) && w.width > 0 && w.height > 0);
/** Picking something to record rather than to capture: the same overlay, with
 *  Record in place of Capture and Copy, and the microphone beside the delay. */
const recording = window.__MARK_KIND__ === 'video';
/** A recording's first step: what it is to be of, before anything is aimed. */
const CHOOSE_HINT = 'Choose what to record · Escape to cancel';
const HINTS: Record<Mode, string> = recording ? {
  region: 'Drag to select a region to record · Escape to cancel',
  window: windows.length ? 'Click a window to record it · Escape to cancel' : 'No windows to record · Escape to cancel',
} : {
  region: 'Drag to select a region · Space for a window · Escape to cancel',
  window: windows.length ? 'Click a window to capture it, ⌘-click to copy it · Space for a region · Escape to cancel'
                         : 'No windows to capture · Space for a region · Escape to cancel',
};

/** What a recording can be of, offered up front -- as macOS's own recording
 *  toolbar does -- rather than behind Space and ⌘A: part of the screen, one
 *  window, or all of this display. Drawn as the editor's tiles draw them. */
type Choice = 'region' | 'window' | 'screen';
const CHOICES: { id: Choice; name: string; tip: string; art: string }[] = [
  { id: 'region', name: 'Region', tip: 'Drag out part of the screen to record', art:
    '<path d="M4.4 7.7V5.9a1.5 1.5 0 0 1 1.5-1.5h1.8M12.3 4.4h1.8a1.5 1.5 0 0 1 1.5 1.5v1.8M15.6 12.3v1.8a1.5 1.5 0 0 1-1.5 1.5h-1.8M7.7 15.6H5.9a1.5 1.5 0 0 1-1.5-1.5v-1.8"/>' },
  { id: 'window', name: 'Window', tip: 'Click a window to record it, even as it moves (Space)', art:
    '<rect x="3.2" y="4.4" width="13.6" height="11.2" rx="1.8"/><path d="M3.2 7.8h13.6"/>' },
  { id: 'screen', name: 'Screen', tip: 'Record all of this display (⌘A)', art:
    '<rect x="3.2" y="4.5" width="13.6" height="9.6" rx="1.8"/><path d="M7.6 16.6h4.8"/>' },
];

const root = document.querySelector<HTMLDivElement>('#selector')!;
root.innerHTML = `
  <div class="veil"></div>
  <div class="guide guide-x" hidden></div>
  <div class="guide guide-y" hidden></div>
  <div class="shot" hidden>
    ${['nw', 'ne', 'se', 'sw'].map(corner => `<span class="grip ${corner}" data-grip="${corner}"></span>`).join('')}
  </div>
  <div class="pick" hidden></div>
  <div class="pick-label" hidden><span class="pick-name"></span><span class="pick-size"></span></div>
  <div class="readout" hidden></div>
  <div class="hint"></div>
  ${recording ? `<div class="choices" role="radiogroup" aria-label="What to record">${CHOICES.map(choice =>
    `<button class="choice" type="button" role="radio" aria-checked="false" data-choice="${choice.id}" title="${choice.tip}">`
    + `<svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${choice.art}</svg>`
    + `${choice.name}</button>`).join('')}</div>` : ''}
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
    <button class="mic icon" type="button" aria-pressed="false" aria-label="Record the microphone too" title="Record the microphone too"${recording ? '' : ' hidden'}>
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <rect x="7.4" y="2.8" width="5.2" height="9.2" rx="2.6"/><path d="M4.6 9.6a5.4 5.4 0 0 0 10.8 0M10 15v2.4"/></svg>
    </button>
    <button class="full icon" type="button" aria-label="Whole display" title="Whole display">
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <path d="M4 8V5.2A1.2 1.2 0 0 1 5.2 4H8M12 4h2.8A1.2 1.2 0 0 1 16 5.2V8M16 12v2.8a1.2 1.2 0 0 1-1.2 1.2H12M8 16H5.2A1.2 1.2 0 0 1 4 14.8V12"/></svg>
    </button>
    <button class="copy" type="button" title="Copy it without opening the editor (⌘C)"${recording ? ' hidden' : ''}>Copy</button>
    <button class="go" type="button">${recording ? '<span class="dot" aria-hidden="true"></span>Record' : 'Capture'}</button>
  </div>
`;
const veil = root.querySelector<HTMLElement>('.veil')!;
const guideX = root.querySelector<HTMLElement>('.guide-x')!;
const guideY = root.querySelector<HTMLElement>('.guide-y')!;
const shot = root.querySelector<HTMLElement>('.shot')!;
const readout = root.querySelector<HTMLElement>('.readout')!;
const pick = root.querySelector<HTMLElement>('.pick')!;
const pickLabel = root.querySelector<HTMLElement>('.pick-label')!;
const hint = root.querySelector<HTMLElement>('.hint')!;
const panel = root.querySelector<HTMLElement>('.panel')!;
const widthField = root.querySelector<HTMLInputElement>('.w')!;
const heightField = root.querySelector<HTMLInputElement>('.h')!;
const lock = root.querySelector<HTMLButtonElement>('.lock')!;
const delayButton = root.querySelector<HTMLButtonElement>('.delay')!;
const micButton = root.querySelector<HTMLButtonElement>('.mic')!;
const choices = root.querySelector<HTMLElement>('.choices');
document.documentElement.dataset.kind = recording ? 'video' : 'shot';

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
let mic = recording && window.__MARK_MIC__ === true;
let mode: Mode = window.__MARK_MODE__ === 'window' ? 'window' : 'region';
/** A recording starts by asking what it is of -- a region, a window or the
 *  screen -- with nothing to aim yet: no crosshair, no guides, and a press on
 *  the screen does nothing until one is chosen. Asked for a window, it is
 *  already chosen. */
let choosing = recording && mode !== 'window';
/** In window mode, the window under the pointer: the one a click takes. */
let picked: ScreenWindow | null = null;
/** Where the pointer last was, so switching to window mode can pick at once --
 *  to begin with, where Rust saw it, if that is on this display. */
let pointer: [number, number] | null = (() => {
  const at = window.__MARK_POINTER__;
  if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return null;
  const x = at.x - display.x, y = at.y - display.y;
  return x >= 0 && y >= 0 && x < display.width && y < display.height ? [x, y] : null;
})();

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

/** Full-width and full-height guides through the pointer, so an edge can be
 *  lined up with something on the far side of the screen. They are for aiming:
 *  shown while choosing a corner or dragging one, and out of the way once a
 *  region is settled and the panel has taken over. */
function guide(x: number | null, y: number | null) {
  const aiming = !choosing && (drag !== null || rect === null);
  const on = aiming && x !== null && y !== null;
  guideX.hidden = guideY.hidden = !on;
  if (!on) return;
  guideX.style.top = `${y}px`;
  guideY.style.left = `${x}px`;
}

/** Whether the selection is this whole display: Screen, as a recording's
 *  choices name it. */
const whole = () => rect !== null && rect.x <= 0 && rect.y <= 0
  && rect.width >= display.width - 0.5 && rect.height >= display.height - 0.5;

function show() {
  hint.textContent = hint.dataset.error ?? (choosing ? CHOOSE_HINT : HINTS[mode]);
  const chosen: Choice | null = choosing ? null : mode === 'window' ? 'window' : whole() ? 'screen' : 'region';
  for (const button of choices?.querySelectorAll<HTMLButtonElement>('.choice') ?? []) {
    button.setAttribute('aria-checked', String(button.dataset.choice === chosen));
  }
  document.documentElement.dataset.mode = choosing ? 'choose' : mode;
  if (choosing) {
    veil.hidden = hint.hidden = false;
    veil.classList.remove('clear');
    shot.hidden = panel.hidden = readout.hidden = pick.hidden = pickLabel.hidden = true;
    guideX.hidden = guideY.hidden = true;
    return;
  }
  pick.hidden = pickLabel.hidden = mode !== 'window' || picked === null;
  // The veil is what the pointer lands on, so in window mode it stays, and only
  // goes clear while the picked window -- a hole in the dimming, as a region
  // is -- does the dimming instead.
  veil.classList.toggle('clear', mode === 'window' && picked !== null);
  if (mode === 'window') {
    veil.hidden = false;
    shot.hidden = panel.hidden = readout.hidden = true;
    hint.hidden = false;
    guideX.hidden = guideY.hidden = true;
    if (picked) placePick(picked);
    return;
  }
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
 *  last resort on a very tall selection -- never over a recording's choices. */
function placePanel() {
  if (!rect) return;
  const box = panel.getBoundingClientRect();
  const floor = choices ? choices.getBoundingClientRect().top - 10 : innerHeight - 8;
  const left = Math.min(Math.max(rect.x + rect.width / 2 - box.width / 2, 8), innerWidth - box.width - 8);
  const below = rect.y + rect.height + 10;
  const above = rect.y - box.height - 10;
  const top = below + box.height <= floor ? below
            : above >= 8 ? above
            : Math.max(8, Math.min(rect.y + rect.height, floor) - box.height - 10);
  Object.assign(panel.style, { left: `${left}px`, top: `${top}px` });
}

/** Frame the window, and name it in the middle of the part of it on this
 *  display -- a window can hang off the edge, or across two. */
function placePick(target: ScreenWindow) {
  const left = target.x - display.x, top = target.y - display.y;
  Object.assign(pick.style, { left: `${left}px`, top: `${top}px`, width: `${target.width}px`, height: `${target.height}px` });
  const seen = {
    left: Math.max(left, 0), top: Math.max(top, 0),
    right: Math.min(left + target.width, display.width), bottom: Math.min(top + target.height, display.height),
  };
  pickLabel.querySelector('.pick-name')!.textContent = target.title ? `${target.app} — ${target.title}` : target.app;
  pickLabel.querySelector('.pick-size')!.textContent = `${Math.round(target.width)} × ${Math.round(target.height)}`;
  Object.assign(pickLabel.style, {
    left: `${(seen.left + seen.right) / 2}px`, top: `${(seen.top + seen.bottom) / 2}px`,
    maxWidth: `${Math.max(120, Math.min(seen.right - seen.left - 24, 560))}px`,
  });
}

/** The frontmost window under a point on this display, if any. */
function windowAt(x: number, y: number): ScreenWindow | null {
  const gx = display.x + x, gy = display.y + y;
  return windows.find(w => gx >= w.x && gx < w.x + w.width && gy >= w.y && gy < w.y + w.height) ?? null;
}

function hover(next: ScreenWindow | null) {
  if (next?.id === picked?.id) return;
  picked = next;
  show();
}

/** Region or window. Every display's overlay switches together, so the mode
 *  does not depend on which one happens to have the keyboard. */
function setMode(next: Mode, tell: boolean) {
  if (next === mode && !choosing) return;
  choosing = false;
  mode = next;
  drag = null; rect = null; delete hint.dataset.error;
  picked = mode === 'window' && pointer ? windowAt(...pointer) : null;
  show();
  if (tell && inTauri) {
    void import('@tauri-apps/api/event').then(({ emit }) => emit('selection-mode', { mode: next }));
  }
}

function setRect(next: Rect | null) {
  rect = next && clampRect(next, display.width, display.height);
  show();
}

function point(event: PointerEvent): [number, number] { return [event.clientX, event.clientY]; }

root.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  // The choices are buttons to press, not somewhere to start a selection; and
  // until one is chosen there is nothing to start.
  if ((event.target as Element).closest('.choices') || choosing) return;
  if (mode === 'window') {
    event.preventDefault();
    const under = windowAt(event.clientX, event.clientY);
    if (under) void captureWindow(under, event.metaKey);
    return;
  }
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
  pointer = [event.clientX, event.clientY];
  const overChoices = (event.target as Element).closest?.('.choices');
  if (mode === 'window') { hover(overChoices ? picked : windowAt(event.clientX, event.clientY)); return; }
  // The panel is a place to click, not to aim through.
  const overPanel = (event.target as Element).closest?.('.panel');
  guide(overPanel ? null : event.clientX, overPanel ? null : event.clientY);
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

root.addEventListener('pointerleave', () => {
  pointer = null;
  guide(null, null);
  if (mode === 'window') hover(null);
});
root.addEventListener('pointerup', event => {
  if (!drag) return;
  const started = drag.kind === 'new';
  drag = null;
  if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
  // A click with no drag is not a region; go back to an empty screen.
  if (started && rect && (rect.width < 6 || rect.height < 6)) rect = null;
  if (rect) ratio = rect.width / Math.max(rect.height, 1);
  guide(null, null);
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
  const verb = recording ? 'Record' : 'Capture';
  delayButton.title = delay ? `${verb} ${delay} seconds after you press ${verb}` : `${verb} after a delay`;
  delayButton.setAttribute('aria-label', delayButton.title);
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
function showMic() {
  micButton.setAttribute('aria-pressed', String(mic));
  micButton.title = mic ? 'Recording the microphone too' : 'Record the microphone too';
}
micButton.addEventListener('click', () => { mic = !mic; showMic(); });
showMic();
root.querySelector('.full')!.addEventListener('click', () => {
  setRect({ x: 0, y: 0, width: display.width, height: display.height });
});
choices?.addEventListener('click', event => {
  const choice = (event.target as Element).closest<HTMLButtonElement>('.choice')?.dataset.choice as Choice | undefined;
  if (choice) choose(choice);
});
/** A recording's choice, from its buttons or their keys: picking a window,
 *  all of this display, or part of it, to drag out. */
function choose(choice: Choice) {
  if (choice === 'window') setMode('window', true);
  else if (choice === 'screen') {
    setMode('region', true);
    setRect({ x: 0, y: 0, width: display.width, height: display.height });
    // This display, so not another's: a selection there gives way.
    void announce();
  } else {
    setMode('region', true);
    // From all of it back to choosing part of it.
    if (whole()) setRect(null);
  }
}
root.querySelector('.cancel')!.addEventListener('click', () => void cancel());
root.querySelector('.go')!.addEventListener('click', () => void capture());
root.querySelector('.copy')!.addEventListener('click', () => void capture(true));

/** What a recording takes with it: that it is one, and the microphone or not. */
const asRecording = () => (recording ? { record: true, mic } : {});

/** `copy`: straight to the clipboard, without opening the editor. A recording
 *  is never copied from here: it has not been made yet. */
async function capture(copy = false) {
  if (!rect || sent) return;
  const { x, y, width, height } = rect;
  if (width < 1 || height < 1) return;
  sent = true;
  await invoke('capture_rect', {
    x: display.x + x, y: display.y + y, width, height, delay, copy: copy && !recording, ...asRecording(),
  }).catch(error => { sent = false; console.error('[Mark]', error); });
}
async function captureWindow(target: ScreenWindow, copy = false) {
  if (sent) return;
  sent = true;
  await invoke('capture_window', { id: target.id, delay, copy: copy && !recording, ...asRecording() }).catch(error => {
    // Most likely the window closed while the overlay was up: say so, and let
    // another be picked.
    sent = false;
    hint.dataset.error = String(error);
    show();
  });
}
async function cancel() {
  if (sent) return;
  sent = true;
  await invoke('cancel_selection').catch(error => { sent = false; console.error('[Mark]', error); });
}

document.addEventListener('keydown', event => {
  const typing = (event.target as HTMLElement)?.tagName === 'INPUT';
  // Space switches between a region and a window, as in macOS's own -- but not
  // mid-drag, and not on a focused button, which Space presses.
  const pressing = (event.target as HTMLElement)?.tagName === 'BUTTON';
  if (event.key === 'Escape') { event.preventDefault(); void cancel(); }
  else if (event.key === ' ' && !typing && !pressing) {
    event.preventDefault();
    if (!event.repeat && !drag) setMode(mode === 'window' ? 'region' : 'window', true);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (typing) (event.target as HTMLInputElement).blur();
    else if (mode === 'window') { if (picked) void captureWindow(picked); }
    else void capture();
  } else if (mode === 'region' && !typing && event.key === 'a' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    if (recording) choose('screen');
    else setRect({ x: 0, y: 0, width: display.width, height: display.height });
  } else if (!recording && !typing && event.key === 'c' && (event.metaKey || event.ctrlKey)) {
    // Copy: what Capture would take, but to the clipboard, without the editor.
    event.preventDefault();
    if (mode === 'window') { if (picked) void captureWindow(picked, true); }
    else void capture(true);
  }
});

// Only one display may hold the selection, so a drag here clears the others;
// and a switch between region and window made on one is made on all of them.
if (inTauri) {
  void import('@tauri-apps/api/event').then(({ listen }) => Promise.all([
    listen('selection-started', () => { if (!drag) { rect = null; show(); } }),
    listen<{ mode: Mode }>('selection-mode', event => setMode(event.payload.mode, false)),
  ]));
}
if (mode === 'window' && pointer) picked = windowAt(...pointer);
show();
