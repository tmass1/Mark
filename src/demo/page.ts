/** The web demo: a Mac desktop drawn in a page, with Mark running on it.
 *
 *  The desktop is a picture. Mark is not: the editor, with its settings, and
 *  the selection overlay are the real pages, each in a frame, running their native
 *  code path against this file, which plays lib.rs -- it keeps the capture,
 *  crops the scene where the overlay says, sizes the editor's window the way
 *  fit_window does, copies to the clipboard, answers settings, and records this
 *  desktop to a real movie, as recording.rs records a screen. What cannot be done
 *  in a browser (Liquid Glass, capturing your actual screen, login items) is said
 *  so, not faked. */
import './page.css';
import pkg from '../../package.json';
import { lookOf, type Look } from '../look';
import { DEFAULT_SHORTCUT, prettyShortcut, shortcutFromEvent } from '../shortcut';
import { clock } from '../trim';
import type { DemoFrame, DemoHost } from './bridge';
import type { Asked, Video } from '../platform';
import { Recording, canRecord, movieScale, type Area, type Take } from './recorder';
import type { Asked as Copying } from './export';

// ---- geometry, mirroring lib.rs ------------------------------------------
const CHROME = 46 + 48 + 10 + 10 + 60;
const SIDES = 12 + 10 + 12;
const RAIL = 44;
const RAIL_HEIGHT = 310 + 8 + RAIL + 6;   // the tool pane, the gap, the crop pane, and air beneath
const COMPACT: [number, number] = [560, CHROME + RAIL_HEIGHT];
const SETTINGS_WIDTH = 560;
const MENU_BAR = 24;
/** recording.rs: the trim strip under a recording, the bar's window and how far
 *  it sits from what is recorded, how far out the outline sits, and how long a
 *  recording may run. */
const STRIP = 12 + 52;
const BAR_SIZE: [number, number] = [256, 88];
const BAR_GAP = 6;
const OUTSET = 3;
const LONGEST = 300;
/** COUNTDOWN_SIZE in recording.rs: room round the disc for its shadow. */
const DISC = 260;
/** The app's own shortcut. Browsers use ⌘-digit for their tabs, but it is not
 *  among the keys they refuse to hand a page, so the demo takes it and stops it
 *  going further; the menu-bar icon is there for any browser that disagrees. */
const DEMO_SHORTCUT = DEFAULT_SHORTCUT;

interface Capture { dataUrl: string; width: number; height: number; scale: number; video?: Video }
interface Settings {
  appearance: 'dark' | 'light' | 'system'; shortcut: string; checkUpdates: boolean; frame?: unknown;
  shortcuts?: { window?: string; display?: string; timed?: string; record?: string };
  afterCapture?: 'editor' | 'thumbnail'; mcp?: boolean; recordMic?: boolean; recordZoom?: boolean;
  recordingPointer?: string; recordingClicks?: string; showInDock?: boolean; installUpdates?: boolean;
}
type Way = 'region' | 'window' | 'display' | 'timed' | 'record';
const WAY_NAMES: Record<Way, string> = { region: 'Capture Region', window: 'Capture Window', display: 'Capture Whole Screen', timed: 'Timed Region', record: 'Record Video' };
const shortcutOf = (way: Way) => way === 'region' ? state.settings.shortcut : state.settings.shortcuts?.[way] ?? '';

const state = {
  capture: null as Capture | null, busy: false, error: null as string | null,
  /** Claude's ask, while one waits: the demo plays the AI tool. */
  request: null as Asked | null,
  settings: { appearance: 'dark', shortcut: DEMO_SHORTCUT, checkUpdates: true } as Settings,
  armedDelay: 0,
  armedMode: 'region' as 'region' | 'window',
  armedKind: 'shot' as 'shot' | 'video',
};

/** The one app window in the picture of a desktop, as fractions of it, so
 *  window mode has something to pick: measured off scene.jpg (2880 × 1800),
 *  where it spans 340–2539 across and 236–1615 down. */
const SCENE_WINDOW = { id: 1, app: 'Dashboard', title: 'Overview', x: 340 / 2880, y: 236 / 1800, width: 2200 / 2880, height: 1380 / 1800 };
function sceneWindows() {
  const w = stage.offsetWidth, h = stage.offsetHeight;
  return [{ ...SCENE_WINDOW, x: SCENE_WINDOW.x * w, y: SCENE_WINDOW.y * h, width: SCENE_WINDOW.width * w, height: SCENE_WINDOW.height * h }];
}

/** In the site's frame the page is the desktop and nothing else: no caption,
 *  no margin, and the frame around it is the host's to draw. */
const embedded = new URLSearchParams(location.search).has('embed');
document.documentElement.classList.toggle('embedded', embedded);

// ---- the page --------------------------------------------------------------
document.body.innerHTML = `
  <div class="stage-box"><div class="stage">
    <img class="scene" src="./demo/scene.jpg" alt="" draggable="false" />
    <img class="scene-top" alt="" draggable="false" hidden />
    <div class="spots"></div>
    <div class="menubar">
      <span class="menubar-app">Mark</span>
      <span class="menubar-right">
        <span class="countdown" hidden></span>
        <button class="tray" type="button" title="Mark" aria-haspopup="true" aria-expanded="false">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.4 7.7V5.9a1.5 1.5 0 0 1 1.5-1.5h1.8M12.3 4.4h1.8a1.5 1.5 0 0 1 1.5 1.5v1.8M15.6 12.3v1.8a1.5 1.5 0 0 1-1.5 1.5h-1.8M7.7 15.6H5.9a1.5 1.5 0 0 1-1.5-1.5v-1.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M13.2 6.8 8.4 11.6M8.4 11.6h3.1M8.4 11.6V8.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <span class="clock"></span>
      </span>
      <div class="tray-menu" role="menu" hidden>
        <button role="menuitem" data-act="capture">Capture Region <kbd></kbd></button>
        <button role="menuitem" data-act="window">Capture Window <kbd></kbd></button>
        <button role="menuitem" data-act="display">Capture Whole Screen <kbd></kbd></button>
        <button role="menuitem" data-act="timed">Timed Region <kbd></kbd></button>
        <button role="menuitem" data-act="record">Record Video <kbd></kbd></button>
        <button role="menuitem" data-act="show">Show Editor</button>
        <hr />
        <button role="menuitem" data-act="settings">Settings… <kbd>⌘,</kbd></button>
        <button role="menuitem" data-act="quit">Quit Mark</button>
      </div>
    </div>
    <div class="win editor" hidden>
      <span class="lights"><button class="light close" type="button" aria-label="Close"></button><i></i><i></i></span>
      <iframe class="frame" title="Mark" src="./demo/editor.html"></iframe>
    </div>
    <div class="hint"><span></span></div>
    <aside class="sent" hidden aria-live="polite" aria-label="What Claude received">
      <header class="sent-head"><strong>What Claude received</strong><button class="sent-close" type="button" aria-label="Dismiss">×</button></header>
      <img class="sent-image" alt="The image Claude received" />
      <pre class="sent-text"></pre>
      <p class="sent-note">On the Mac, the words in the picture go with it too, read off it by macOS.</p>
    </aside>
    <aside class="clip" hidden aria-live="polite">
      <img class="clip-image" alt="The image that was copied" />
      <video class="clip-movie" muted loop playsinline hidden></video>
      <div class="clip-text"><strong></strong><small class="clip-meta"></small></div>
      <div class="clip-actions">
        <button class="clip-save" type="button">Save PNG</button>
        <button class="clip-close" type="button" aria-label="Dismiss">×</button>
      </div>
    </aside>
  </div></div>
  <p class="caption">This is Mark's real editor, selection overlay and settings, running in your browser against a stand-in for the Mac.
    Capturing takes a region or the window of this picture of a desktop; Copy puts a real PNG on your clipboard, and Record makes
    a real video of it, with what you click on the dashboard. Liquid Glass, capturing your actual screen, reading the words in it,
    and opening at login need the Mac app.</p>`;

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const stage = $<HTMLDivElement>('.stage');
const editorWin = $<HTMLDivElement>('.win.editor'), editorFrame = editorWin.querySelector('iframe')!;
const tray = $<HTMLButtonElement>('.tray'), trayMenu = $<HTMLDivElement>('.tray-menu');
const countdown = $<HTMLElement>('.countdown'), hint = $<HTMLElement>('.hint span');
let overlay: HTMLIFrameElement | null = null;
let editorWanted = true;   // whether the editor should be on screen when nothing else is happening
let settingsHeight: number | null = null;   // how tall Settings want the editor, while they show
let recordingFit: [number, number] | null = null;   // the recording Recent reopened, as fit_to_recording has it

const frames = (): DemoFrame[] => [editorFrame, overlay].flatMap(f => f?.contentWindow ? [f.contentWindow as DemoFrame] : []);
const emit = (event: string, payload: unknown = null) => { for (const f of frames()) f.__markDemoEmit?.(event, payload); };
const emitTo = (frame: HTMLIFrameElement, event: string, payload: unknown = null) => (frame.contentWindow as DemoFrame | null)?.__markDemoEmit?.(event, payload);

// ---- the scene, and cropping it -------------------------------------------
const scene = $<HTMLImageElement>('.scene'), sceneTop = $<HTMLImageElement>('.scene-top');
const sceneReady = scene.complete ? Promise.resolve() : new Promise<void>(resolve => scene.addEventListener('load', () => resolve(), { once: true }));
/** What the dashboard in the picture answers a click with, each state a picture of
 *  its own (scripts/demo/render-scene.mjs). Where to click is measured off them, in
 *  points of the 1440 × 900 desktop. */
type SceneState = 'overview' | '7d' | '90d' | '1y' | 'orders' | 'customers';
const SCENE_FILES: Record<SceneState, string> = {
  overview: 'scene', '7d': 'scene-7d', '90d': 'scene-90d', '1y': 'scene-1y', orders: 'scene-orders', customers: 'scene-customers',
};
const RANGES: readonly SceneState[] = ['overview', '7d', '90d', '1y'];
const SPOTS: { to: SceneState; name: string; x: number; y: number; width: number; height: number; range?: boolean }[] = [
  { to: 'overview', name: 'Overview', x: 182, y: 162, width: 195, height: 27 },
  { to: 'orders', name: 'Orders', x: 182, y: 191, width: 195, height: 27 },
  { to: 'customers', name: 'Customers', x: 182, y: 220, width: 195, height: 27 },
  { to: '7d', name: 'Last 7 days', x: 1009, y: 131, width: 37, height: 25, range: true },
  { to: 'overview', name: 'Last 30 days', x: 1045, y: 131, width: 46, height: 25, range: true },
  { to: '90d', name: 'Last 90 days', x: 1091, y: 131, width: 46, height: 25, range: true },
  { to: '1y', name: 'Last year', x: 1137, y: 131, width: 34, height: 25, range: true },
];
const FADE = 120;
const scenes = new Map<SceneState, Promise<HTMLImageElement>>();
function sceneNamed(state: SceneState): Promise<HTMLImageElement> {
  let loading = scenes.get(state);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image); image.onerror = reject;
      image.src = `./demo/${SCENE_FILES[state]}.jpg`;
    });
    scenes.set(state, loading);
  }
  return loading;
}
let sceneNow: SceneState = 'overview';
let sceneShown: HTMLImageElement = scene;
let sceneFade: { from: HTMLImageElement; at: number } | null = null;
const spots = $<HTMLElement>('.spots');
spots.append(...SPOTS.map(spot => {
  const button = Object.assign(document.createElement('button'), { type: 'button', className: 'spot', title: spot.name });
  button.setAttribute('aria-label', spot.name);
  button.dataset.to = spot.to;
  if (spot.range) button.dataset.range = '';
  Object.assign(button.style, {
    left: `${spot.x / 14.4}%`, top: `${spot.y / 9}%`, width: `${spot.width / 14.4}%`, height: `${spot.height / 9}%`,
  });
  return button;
}));
spots.addEventListener('click', event => {
  const to = (event.target as Element).closest<HTMLElement>('.spot')?.dataset.to as SceneState | undefined;
  if (to) void showScene(to);
});
async function showScene(state: SceneState) {
  if (state === sceneNow) return;
  sceneNow = state;
  spots.classList.toggle('no-range', !RANGES.includes(state));
  const image = await sceneNamed(state);
  if (sceneNow !== state) return;
  sceneFade = { from: sceneShown, at: performance.now() };
  sceneShown = image;
  sceneTop.src = image.src; sceneTop.hidden = false;
  const fading = sceneTop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE });
  await fading.finished.catch(() => {});
  if (sceneShown === image) { scene.src = image.src; sceneTop.hidden = true; }
}
// The rest of the dashboard is fetched once someone comes near it, not with the page.
$<HTMLElement>('.stage').addEventListener('pointerenter', () => {
  scenes.set('overview', Promise.resolve(scene));
  for (const state of Object.keys(SCENE_FILES) as SceneState[]) void sceneNamed(state);
}, { once: true });
/** The desktop as it stands, a change under way fading in, for a recording. */
function paintDesktop(context: CanvasRenderingContext2D, area: Area, width: number, height: number) {
  const s = sceneScale();
  const draw = (image: HTMLImageElement) => context.drawImage(image, area.x * s, area.y * s, area.width * s, area.height * s, 0, 0, width, height);
  const fading = sceneFade ? (performance.now() - sceneFade.at) / FADE : 1;
  if (sceneFade && fading < 1) { draw(sceneFade.from); context.globalAlpha = fading; draw(sceneShown); context.globalAlpha = 1; }
  else draw(sceneShown);
}
/** Scene pixels per stage point: the picture is 2x of a 1440-wide desktop, shown at whatever width the page allows. */
const sceneScale = () => scene.naturalWidth / stage.offsetWidth;

async function crop(x: number, y: number, width: number, height: number): Promise<Capture> {
  await sceneReady;
  const s = sceneScale();
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * s)); canvas.height = Math.max(1, Math.round(height * s));
  canvas.getContext('2d')!.drawImage(sceneShown, Math.round(x * s), Math.round(y * s), canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, scale: s };
}

// ---- windows ---------------------------------------------------------------
/** fit_window: the capture at actual size where the stage allows, compact when empty. */
function fitEditor() {
  let [w, h] = state.capture
    ? [state.capture.width / state.capture.scale + SIDES + RAIL, state.capture.height / state.capture.scale + CHROME + (state.capture.video ? STRIP : 0)]
    : COMPACT;
  if (recordingFit) { w = Math.max(w, recordingFit[0] + SIDES + RAIL); h = Math.max(h, recordingFit[1] + STRIP + CHROME); }
  // fit_to_settings: grown to show Settings without scrolling, while they show.
  if (settingsHeight !== null) { w = Math.max(w, SETTINGS_WIDTH); h = Math.max(h, settingsHeight); }
  w = Math.min(w, stage.offsetWidth - 80); h = Math.min(h, stage.offsetHeight - 80);
  w = Math.max(w, 380); h = Math.max(h, Math.min(CHROME + RAIL_HEIGHT, stage.offsetHeight - 40));
  place(editorWin, w, h);
}
function place(win: HTMLElement, w: number, h: number) {
  win.style.width = `${Math.round(w)}px`; win.style.height = `${Math.round(h)}px`;
  if (!win.dataset.moved) {
    win.style.left = `${Math.round((stage.offsetWidth - w) / 2)}px`;
    win.style.top = `${Math.round(Math.max(30, (stage.offsetHeight - h) / 2))}px`;
  }
}
function showEditor(show: boolean) { editorWin.hidden = !show; if (show) { fitEditor(); raise(editorWin); } }
function raise(win: HTMLElement) { for (const w of document.querySelectorAll<HTMLElement>('.win')) w.classList.toggle('front', w === win); }
function showHint(text: string | null) {
  const pill = hint.parentElement!;
  pill.hidden = !text; hint.textContent = text ?? '';
  // A change of text crossfades, so a tip arriving reads as arriving.
  pill.classList.remove('swap'); void pill.offsetWidth; pill.classList.add('swap');
}
/** What Record says in a browser that can't make a movie. */
const RECORD_HINT = 'This browser can’t record a video. The Mac app can: up to five minutes of a region, a window or the whole screen.';

// ---- tips ------------------------------------------------------------------
/** With a capture open, the pill teaches one thing at a time, in about the order
 *  a first drawing raises them. Nothing here is invented for the demo: each is
 *  something the app does. */
const TIPS = [
  'Drag to draw. The tip of an arrow lands exactly where you let go.',
  'Four arrow styles sit beside the colours: Mark’s own, tapered, solid and thin.',
  'Drag an arrow\'s end to reshape it, or its body to move it.',
  '⌘Z takes the last thing back, a crop included.',
  'Redact pixelates rather than blurs: a blur can be undone.',
  'Shift-click gathers several annotations; they then move and restyle together.',
  'Crop keeps the drawing, shifted to match. ⌘Z puts the whole capture back.',
  '⌘C copies the image and keeps working. ⌥⌘C copies and closes.',
  'Closed a capture by accident? Recent, on the empty state, holds the last six.',
];
/** And with a recording open. */
const MOVIE_TIPS = [
  'Drag the yellow handles to keep only the part that matters. K cuts a second out of the middle.',
  'Z zooms in at the playhead. Drag a zoom’s ends along the strip, or click it for 2× or 3×.',
  'Pause where a mark belongs, then draw: it appears from that moment.',
  'Select a mark and drag its second flag in: it goes before the end.',
  '1× after the timeline turns to 2×, for the player and every copy.',
  'Frame puts it on a background, in a phone, a tablet or a browser.',
  'Save Video makes a real file here in your browser, with everything drawn into it.',
];
const TIP_EVERY = 6500;
let tipTimer: number | undefined, tipIndex = 0, tips = TIPS;
function showTip() {
  const which = tipIndex++ % tips.length;
  showHint(tips[which]); hint.parentElement!.dataset.tip = String(which);
}
function startTips(movie = false) { stopTips(); tipIndex = 0; tips = movie ? MOVIE_TIPS : TIPS; showTip(); tipTimer = window.setInterval(showTip, TIP_EVERY); }
function stopTips() {
  if (tipTimer !== undefined) clearInterval(tipTimer);
  tipTimer = undefined; delete hint.parentElement!.dataset.tip;
}

// ---- what was copied -------------------------------------------------------
/** The clipboard cannot be seen, so a copy would be taken on faith: the card
 *  shows the very bytes that went there, and hands them over as a file when the
 *  browser would not take them. */
const clip = $<HTMLElement>('.clip');
const clipImage = clip.querySelector<HTMLImageElement>('.clip-image')!, clipMeta = clip.querySelector<HTMLElement>('.clip-meta')!;
const clipMovie = clip.querySelector<HTMLVideoElement>('.clip-movie')!, clipSave = clip.querySelector<HTMLButtonElement>('.clip-save')!;
let clipPng = '';
/** A movie or a GIF the card holds, rather than the PNG that went to the clipboard. */
let clipFile: { blob: Blob; name: string } | null = null;
function enterClip() { clip.hidden = false; clip.classList.remove('in'); void clip.offsetWidth; clip.classList.add('in'); }   // the entrance again, for a second copy
function showClip(png: string, refused: string | null) {
  clipPng = png; clipFile = null;
  clipMovie.hidden = true; clipMovie.removeAttribute('src'); clipImage.hidden = false;
  clipSave.textContent = 'Save PNG';
  clipImage.src = `data:image/png;base64,${png}`;
  clipImage.onload = () => { clipMeta.textContent = `${clipImage.naturalWidth} × ${clipImage.naturalHeight} px`; };
  clip.querySelector('strong')!.textContent = refused ? 'The browser refused the copy' : 'On your clipboard';
  clip.classList.toggle('refused', refused !== null);
  enterClip();
}
/** A browser's clipboard takes a picture but not a video or a GIF, so the card holds
 *  the file instead, to save and put wherever it was going. */
function showClipFile(blob: Blob, name: string) {
  clipFile = { blob, name };
  const url = URL.createObjectURL(blob), gif = blob.type === 'image/gif';
  clipMovie.hidden = gif; clipImage.hidden = !gif;
  clipImage.onload = null;
  if (gif) { clipImage.src = url; clipMovie.removeAttribute('src'); }
  else { clipMovie.src = url; void clipMovie.play().catch(() => {}); }
  clipMeta.textContent = sizeOf(blob.size);
  clipSave.textContent = gif ? 'Save GIF' : 'Save Video';
  clip.querySelector('strong')!.textContent = gif ? 'Your GIF' : 'Your video';
  clip.classList.remove('refused');
  enterClip();
}
const sizeOf = (bytes: number) => (bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`);
/** When it is, as macOS names a screenshot and the app's Save suggests. */
function stamp(): string {
  const now = new Date(), pad = (value: number) => String(value).padStart(2, '0');
  return `Mark ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + ` at ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
}
const suggestedName = () => `${stamp()}.png`;
clipSave.addEventListener('click', () => {
  if (clipFile) saveFile(clipFile.blob, clipFile.name); else download(clipPng, suggestedName());
});
clip.querySelector('.clip-close')!.addEventListener('click', () => { clip.hidden = true; clipMovie.pause(); });
// ---- what Claude received --------------------------------------------------
/** The demo plays the AI tool, so what it was sent can be seen: the picture,
 *  and the words that went with it -- what was marked, and where. */
const sent = $<HTMLElement>('.sent');
sent.querySelector('.sent-close')!.addEventListener('click', () => { sent.hidden = true; });
function showSent(png: string, text: string) {
  sent.querySelector<HTMLImageElement>('.sent-image')!.src = `data:image/png;base64,${png}`;
  sent.querySelector('.sent-text')!.textContent = text;
  sent.hidden = false;
  sent.classList.remove('in'); void sent.offsetWidth; sent.classList.add('in');
}
let asks = 0;
/** Claude asking for a screenshot, as an AI tool asks the app through its MCP
 *  server: the editor comes forward with the ask, and the rest is the user's. */
function askAsClaude() {
  if (state.busy) return;
  state.request = { id: ++asks, client: 'Claude', prompt: 'the chart’s peak', mode: 'region', deadline: null };
  sent.hidden = true; clip.hidden = true;
  editorWanted = true; showEditor(true); emitTo(editorFrame, 'capture-changed'); stopTips();
  showHint('Claude asked to see the chart’s peak. Capture it, point at the peak, then press Send to Claude.');
}
// The site's "Let Claude ask" and "Record a video", from the page this demo is framed in.
window.addEventListener('message', event => {
  if (event.origin !== location.origin) return;
  if (event.data === 'mark-demo:ask') askAsClaude();
  if (event.data === 'mark-demo:record') void startWay('record');
});

async function copied(png: string, close: boolean) {
  let refused: string | null = null;
  try { await toClipboard(png); } catch (error) { refused = String(error); }
  showClip(png, refused);
  if (refused) throw refused;                      // the editor's status line says so too
  if (close) await host.invoke('dismiss_editor', {}, editorFrame.contentWindow!, 'editor');
}

/** Dragging by a title area. The frames' bridges report the mousedown; the
 *  page follows the pointer, with the frames made transparent to it meanwhile
 *  so the moves are not swallowed by the very window being moved. */
let drag: { win: HTMLElement; x: number; y: number; left: number; top: number } | null = null;
function beginDrag(win: HTMLElement, screenX: number, screenY: number) {
  drag = { win, x: screenX, y: screenY, left: win.offsetLeft, top: win.offsetTop };
  for (const f of document.querySelectorAll<HTMLIFrameElement>('iframe')) f.style.pointerEvents = 'none';
  raise(win);
}
window.addEventListener('mousemove', e => {
  if (!drag) return;
  const ratio = stage.offsetWidth / stage.getBoundingClientRect().width;   // the stage may be scaled down to fit
  drag.win.style.left = `${drag.left + (e.screenX - drag.x) * ratio}px`;
  drag.win.style.top = `${Math.max(24, drag.top + (e.screenY - drag.y) * ratio)}px`;
  drag.win.dataset.moved = '';
});
function endDrag() {
  drag = null;
  for (const f of document.querySelectorAll<HTMLIFrameElement>('iframe')) f.style.pointerEvents = '';
}
window.addEventListener('mouseup', endDrag);
window.addEventListener('blur', endDrag);

// ---- selection -------------------------------------------------------------
async function beginSelection(delay: number, window = false, record = false) {
  if (state.busy) return;
  state.busy = true; state.armedDelay = delay; state.armedMode = window ? 'window' : 'region'; state.error = null;
  state.armedKind = record ? 'video' : 'shot';
  emitTo(editorFrame, 'capture-changed');
  showEditor(false); stopTips(); showHint(null);
  clip.hidden = true;                              // the desktop is about to be captured
  // One overlay per selection, as in the app, where the window is made fresh each time.
  overlay?.remove();
  overlay = document.createElement('iframe');
  overlay.className = 'overlay'; overlay.title = 'Select a region'; overlay.src = './demo/selector.html';
  // The overlay takes the keyboard, as its window does on the Mac: Escape has to reach it.
  overlay.addEventListener('load', () => { overlay?.contentWindow?.focus(); applyAppearance(); });
  stage.append(overlay);
}
function endSelection() { overlay?.remove(); overlay = null; state.busy = false; }

/** The whole display, straight away or after a delay, as lib.rs's capture_display. */
async function captureDisplay(delay: number) {
  state.busy = true; emitTo(editorFrame, 'capture-changed'); showEditor(false);
  await tick(delay, { x: 0, y: 0, width: stage.offsetWidth, height: stage.offsetHeight });
  const whole = await crop(0, 0, stage.offsetWidth, stage.offsetHeight);
  state.busy = false; await took(whole);
}

/** Each way in, as a shortcut or the menu starts it. */
function startWay(way: Way): Promise<void> {
  // As start_recording: pressed while one runs, it stops it, kept.
  if (way === 'record' && live) return finishRecording(true);
  if (state.busy) return Promise.resolve();
  if (way === 'record') {
    if (!canRecord()) { showHint(RECORD_HINT); return Promise.resolve(); }
    if (state.request) { showHint(WAITING); return Promise.resolve(); }
    return beginSelection(0, false, true);
  }
  if (way === 'display') return captureDisplay(0);
  return beginSelection(way === 'timed' ? 5 : 0, way === 'window');
}

/** The count before a delayed shot, as recording.rs's show_countdown has it: in
 *  the menu bar, and in the app's own disc over the middle of what will be taken,
 *  which clicks go straight through and which is gone before the shutter. */
async function tick(seconds: number, area: Area, video = false) {
  if (seconds <= 0) return;
  const disc = document.createElement('iframe');
  disc.className = 'count-disc'; disc.title = 'Countdown'; disc.tabIndex = -1;
  disc.src = `./demo/recording.html?countdown&until=${Date.now() + seconds * 1000}${video ? '&video' : ''}`;
  disc.style.left = `${Math.round(Math.min(Math.max(0, area.x + (area.width - DISC) / 2), stage.offsetWidth - DISC))}px`;
  disc.style.top = `${Math.round(Math.min(Math.max(MENU_BAR, area.y + (area.height - DISC) / 2), stage.offsetHeight - DISC))}px`;
  stage.append(disc);
  for (let left = seconds; left > 0; left--) {
    countdown.hidden = false; countdown.textContent = `${left}`;
    await new Promise(r => setTimeout(r, 1000));
  }
  countdown.hidden = true;
  disc.remove();
}

// ---- recording ---------------------------------------------------------------
/** As lib.rs says it when an ask is waiting: the recording would open in its place. */
const WAITING = 'Claude is waiting for a screenshot. Send one, or Don’t Send, before recording.';
/** Where the pointer is on the desktop, wherever it went: the page, or a frame over it. */
let pointerNow: [number, number] | null = null;
window.addEventListener('pointermove', event => {
  const box = stage.getBoundingClientRect(), k = stage.offsetWidth / (box.width || 1);
  pointerNow = [(event.clientX - box.left) * k, (event.clientY - box.top) * k];
}, { capture: true, passive: true });
// What is pressed on the desktop, for a recording's clicks; the menu bar and Mark's bar are not on it.
window.addEventListener('pointerdown', event => {
  if (live && !(event.target as Element).closest?.('.menubar')) live.recording.press(true);
}, true);
window.addEventListener('pointerup', () => live?.recording.press(false), true);

const takes = new Map<number, Take>();
let nextTake = 1;
/** How many recordings are kept for Recent to reopen; older ones let go, as Rust's are. */
const MOST_TAKES = 8;
const takeOf = (id: unknown) => {
  const take = takes.get(Number(id));
  if (!take) throw 'That recording is no longer kept. Record it again.';
  return take;
};

/** The recording under way: what follows it round the desktop, and its clock. */
let live: { recording: Recording; bar: HTMLIFrameElement; line: HTMLIFrameElement | null; clock: number; mic: boolean } | null = null;

/** Where the bar goes for what is recorded, as recording.rs's bar_place. */
function barPlace(area: Area): [number, number] {
  const [width, height] = BAR_SIZE;
  const work = { x: 0, y: MENU_BAR, width: stage.offsetWidth, height: stage.offsetHeight - MENU_BAR };
  const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(high, low));
  const x = clamp(area.x + (area.width - width) / 2, work.x, work.x + work.width - width);
  const below = area.y + area.height + BAR_GAP, above = area.y - BAR_GAP - height;
  const y = below + height <= work.y + work.height ? below : above >= work.y ? above
    : clamp(area.y + area.height - BAR_GAP - height, work.y, work.y + work.height - height);
  return [x, y];
}

function recordingStatus() {
  return live ? { elapsed: Math.floor(live.recording.elapsed()), limit: LONGEST, mic: live.mic } : null;
}
/** The menu bar's recording state: the time counting, Stop Recording in place of Record Video, the rest unavailable. */
function recordingMenu(running: boolean) {
  for (const item of trayMenu.querySelectorAll<HTMLButtonElement>('button')) {
    const act = item.dataset.act;
    if (act === 'record') item.firstChild!.textContent = running ? 'Stop Recording ' : 'Record Video ';
    else if (act === 'capture' || act === 'window' || act === 'display' || act === 'timed') item.disabled = running;
  }
}

/** What the overlay chose, recorded from now until something stops it. */
async function beginRecording(area: Area, framed: boolean, delay: number, args: Record<string, unknown>) {
  const look = lookOf(args), zoom = Boolean(args.zoom), wantMic = Boolean(args.mic);
  state.settings = { ...state.settings, recordMic: wantMic, recordZoom: zoom, recordingPointer: look.pointer, recordingClicks: look.clicks };
  overlay?.remove(); overlay = null;
  // Asked for first, as the app asks, before anything is on screen.
  let microphone: MediaStream | null = null;
  if (wantMic) {
    try { microphone = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { showHint('The browser didn’t allow the microphone, so this one has no sound.'); }
  }
  await tick(delay, area, true);
  const id = nextTake++;
  let recording: Recording;
  try {
    recording = new Recording({
      id, area, look, zoom, microphone, scale: movieScale(area, sceneScale()),
      paint: (context, width, height) => paintDesktop(context, area, width, height),
      pointer: () => pointerNow,
    });
    recording.start();
  } catch (error) {
    for (const track of microphone?.getTracks() ?? []) track.stop();
    state.busy = false; state.error = String(error);
    editorWanted = true; showEditor(true); emitTo(editorFrame, 'capture-changed');
    return;
  }
  const bar = document.createElement('iframe');
  bar.className = 'recording-bar'; bar.title = 'Recording'; bar.src = './demo/recording.html';
  [bar.style.left, bar.style.top] = barPlace(area).map(value => `${Math.round(value)}px`);
  const line = framed ? document.createElement('iframe') : null;
  if (line) {
    line.className = 'recording-line'; line.title = 'What is being recorded'; line.tabIndex = -1; line.src = './demo/recording.html?outline';
    Object.assign(line.style, {
      left: `${area.x - OUTSET}px`, top: `${area.y - OUTSET}px`, width: `${area.width + 2 * OUTSET}px`, height: `${area.height + 2 * OUTSET}px`,
    });
    stage.append(line);
  }
  stage.append(bar);
  const show = () => {
    if (!live) return;
    const status = recordingStatus()!;
    if (status.elapsed >= LONGEST) { void finishRecording(true); return; }
    countdown.textContent = clock(status.elapsed);
    emitTo(bar, 'recording-tick', status);
  };
  live = { recording, bar, line, mic: !!microphone, clock: window.setInterval(show, 250) };
  bar.addEventListener('load', show, { once: true });
  countdown.hidden = false; countdown.textContent = clock(0);
  recordingMenu(true);
  // Under the menu bar, since Mark's bar may be where this usually goes.
  hint.parentElement!.classList.add('over');
  showHint('Recording this desktop. Click 7d, 90d or 1y on the dashboard, or Orders in its sidebar, then press Stop.');
}

/** Stopped: kept, it opens in the editor as a capture does; thrown away, all is as it was. */
async function finishRecording(keep: boolean) {
  const ending = live;
  if (!ending) return;
  live = null;
  clearInterval(ending.clock);
  ending.bar.remove(); ending.line?.remove();
  countdown.hidden = true;
  recordingMenu(false);
  hint.parentElement!.classList.remove('over');
  showHint(null);
  const take = await ending.recording.stop(keep);
  state.busy = false;
  if (!take) {
    if (editorWanted) showEditor(true);
    emitTo(editorFrame, 'capture-changed');
    return;
  }
  takes.set(take.id, take);
  for (const id of [...takes.keys()].slice(0, Math.max(0, takes.size - MOST_TAKES))) {
    URL.revokeObjectURL(takes.get(id)!.url); takes.delete(id);
  }
  recordingFit = null;
  await took({
    dataUrl: take.poster, width: take.width, height: take.height, scale: take.scale,
    video: { id: take.id, path: `/Recordings/${take.id}/${stamp()}.mp4`, duration: take.duration, sound: take.sound },
  });
}

/** The file for what the editor asks a copy of: the same asked twice is made once,
 *  since a movie takes as long to make as it runs. */
let madeMovie: { key: string; blob: Blob } | null = null;
const copying = (args: Record<string, unknown>): Copying => ({
  start: Number(args.start), end: Number(args.end), cuts: (args.cuts ?? []) as [number, number][], speed: Number(args.speed ?? 1),
  look: lookOf(args.look), marks: (args.marks ?? null) as Copying['marks'], small: Boolean(args.small),
});
async function movieFile(args: Record<string, unknown>): Promise<Blob> {
  const take = takeOf(args.id), asked = copying(args);
  const key = JSON.stringify([take.id, asked]);
  if (madeMovie?.key === key) return madeMovie.blob;
  const { movieOf } = await import('./export');
  const blob = await movieOf(take, asked);
  madeMovie = { key, blob };
  return blob;
}
async function gifFile(args: Record<string, unknown>): Promise<Blob> {
  const { gifOf } = await import('./export');
  return gifOf(takeOf(args.id), copying(args));
}
/** A movie is named for what the browser could write: an MP4 where it can. */
const movieName = (name: string, blob: Blob) => (blob.type.includes('webm') ? name.replace(/\.mp4$/i, '.webm') : name);
function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Copied straight from the overlay, as lib.rs's keep_copied: onto the
 *  clipboard, then into the editor's Recent without the editor opening -- or,
 *  when the browser refuses the copy, into the editor with it, as the app does
 *  when a copy fails. The editor comes back only if it was out before. */
const copiedCaptures: Capture[] = [];
async function tookCopy(capture: Capture) {
  const png = capture.dataUrl.split(',')[1];
  let refused: string | null = null;
  try { await toClipboard(png); } catch (error) { refused = String(error); }
  showClip(png, refused);
  if (refused) { await took(capture); return; }
  copiedCaptures.push(capture);
  emitTo(editorFrame, 'capture-copied');
  emitTo(editorFrame, 'capture-changed');
  if (editorWanted) showEditor(true);
  else showHint('Copied, without opening the editor. It waits in Recent too.');
}

async function took(capture: Capture) {
  state.capture = capture; state.error = null;
  editorWanted = true;
  showEditor(true);
  emitTo(editorFrame, 'capture-changed');
  if (state.request) showHint('Point at what matters: an arrow, or a numbered step with a note. Then press Send to Claude.');
  else startTips(!!capture.video);
}

// ---- files -----------------------------------------------------------------
function pngBlob(base64: string): Blob {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}
async function toClipboard(base64: string) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob(base64) })]);
  } catch {
    throw 'This browser wouldn\'t allow the copy. Save the image instead.';
  }
}
function download(base64: string, name: string) { saveFile(pngBlob(base64), name); }

// ---- appearance ------------------------------------------------------------
function applyAppearance() {
  const theme = state.settings.appearance === 'system' ? '' : state.settings.appearance;
  // The page too: the window wrappers stand in for the Mac's material, which follows the appearance.
  for (const doc of [document, editorFrame.contentDocument, overlay?.contentDocument]) {
    if (!doc) continue;
    if (theme) doc.documentElement.dataset.theme = theme; else delete doc.documentElement.dataset.theme;
  }
}
editorFrame.addEventListener('load', applyAppearance);

// ---- the part of lib.rs the frames talk to ---------------------------------
export const host: DemoHost & { display(): { x: number; y: number; width: number; height: number; scale: number }; delay(): number; mode(): 'region' | 'window'; windows(): ReturnType<typeof sceneWindows>; beginDrag(label: string, x: number, y: number): void; endDrag(): void; overlaySetup(): Partial<Window>; key(e: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean } = {
  display: () => ({ x: 0, y: 0, width: stage.offsetWidth, height: stage.offsetHeight, scale: sceneScale() }),
  delay: () => state.armedDelay,
  mode: () => state.armedMode,
  windows: sceneWindows,
  /** What Rust hands the overlay for a recording, as the last one was set up. */
  overlaySetup: () => ({
    __MARK_KIND__: state.armedKind, __MARK_MIC__: state.settings.recordMic === true,
    __MARK_LOOK__: lookOf({ pointer: state.settings.recordingPointer, clicks: state.settings.recordingClicks }) as Look,
    __MARK_ZOOM__: state.settings.recordZoom === true,
    __MARK_WORK__: { x: 0, y: MENU_BAR, width: stage.offsetWidth, height: stage.offsetHeight - MENU_BAR },
    __MARK_POINTER__: pointerNow ? { x: pointerNow[0], y: pointerNow[1] } : null,
  }),
  beginDrag(label, x, y) { beginDrag(label === 'recording' && live ? live.bar : editorWin, x, y); },
  endDrag,
  pointerMoved(label, x, y) {
    if (label === 'selector') pointerNow = [x, y];
    else if (label === 'recording' && live) pointerNow = [live.bar.offsetLeft + x, live.bar.offsetTop + y];
  },
  fileSrc(path) { return takes.get(Number(path.split('/')[2]))?.url; },
  key(e) {
    const pressed = shortcutFromEvent(e);
    const way = pressed ? (Object.keys(WAY_NAMES) as Way[]).find(w => shortcutOf(w) === pressed) : undefined;
    if (!way) return false;
    void startWay(way); return true;
  },
  async invoke(command, args) {
    switch (command) {
      case 'current_capture': return { capture: state.capture, error: state.error, busy: state.busy, request: state.request };
      case 'capture_region':
        if (args.record) {
          if (!canRecord()) { showHint(RECORD_HINT); return; }
          if (state.request) throw WAITING;
          await beginSelection(Number(args.delay ?? 0), Boolean(args.window), true); return;
        }
        await beginSelection(Number(args.delay ?? 0), Boolean(args.window)); return;
      case 'capture_display': await captureDisplay(Number(args.delay ?? 0)); return;
      case 'capture_rect': {
        overlay?.remove(); overlay = null;
        const area = { x: Number(args.x), y: Number(args.y), width: Number(args.width), height: Number(args.height) };
        if (args.record) { await beginRecording(area, area.width < stage.offsetWidth - 1 || area.height < stage.offsetHeight - 1, Number(args.delay ?? 0), args); return; }
        await tick(Number(args.delay ?? 0), area);
        const region = await crop(area.x, area.y, area.width, area.height);
        state.busy = false; await (args.copy && !state.request ? tookCopy : took)(region); return;
      }
      case 'capture_window': {
        const picked = sceneWindows().find(w => w.id === Number(args.id));
        if (!picked) throw 'That window has closed. Pick another, or press Escape.';
        if (args.record) { await beginRecording(picked, false, Number(args.delay ?? 0), args); return; }
        overlay?.remove(); overlay = null;
        await tick(Number(args.delay ?? 0), picked);
        const shot = await crop(picked.x, picked.y, picked.width, picked.height);
        state.busy = false; await (args.copy && !state.request ? tookCopy : took)(shot); return;
      }
      case 'take_copied': return copiedCaptures.splice(0);
      case 'cancel_selection': endSelection(); if (editorWanted) showEditor(true); emitTo(editorFrame, 'capture-changed'); return;
      case 'copy_capture': {
        if (!state.capture) throw 'Nothing to copy yet.';
        await copied(state.capture.dataUrl.split(',')[1], Boolean(args.close)); return;
      }
      case 'copy_edited': await copied(String(args.png), Boolean(args.close)); return;
      case 'copy_text': await navigator.clipboard.writeText(String(args.text)); return;
      case 'save_image': download(String(args.png), String(args.name)); return String(args.name);
      case 'share_image': {
        const file = new File([pngBlob(String(args.png))], String(args.name), { type: 'image/png' });
        if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }).catch(() => {}); return; }
        download(String(args.png), String(args.name)); return;
      }
      case 'dismiss_editor': {
        if (state.busy) throw 'Press Escape to cancel the selection first.';
        // As in the app, closing the editor is a no to an ask still waiting.
        const declined = state.request !== null;
        state.capture = null; state.error = null; state.request = null; editorWanted = false; recordingFit = null;
        showEditor(false); emitTo(editorFrame, 'capture-changed'); stopTips();
        showHint(declined ? 'Closed, which tells Claude no.'
          : `Closed. Click the Mark icon in the menu bar, or press ${prettyShortcut(state.settings.shortcut)}, to capture again.`);
        return;
      }
      case 'open_screen_settings': return;
      case 'screen_access_granted': return true;
      case 'fit_to_settings':
        settingsHeight = args.height === null || args.height === undefined ? null : Number(args.height);
        if (!editorWin.hidden) fitEditor();
        return;
      case 'quit_app': {
        editorWanted = false; showEditor(false); endSelection(); stopTips();
        showHint('Mark quit. Click its icon in the menu bar to open it again.'); return;
      }
      case 'glass_available': return false;
      case 'set_glass': return;
      case 'get_settings': return state.settings;
      case 'set_appearance': {
        state.settings = { ...state.settings, appearance: args.appearance as Settings['appearance'] };
        applyAppearance(); emit('settings-changed', state.settings); return state.settings;
      }
      case 'set_shortcut': {
        // As lib.rs: Capture Region's with no way named, the others by name, an
        // empty shortcut clearing one, and no two ways sharing a key.
        const way = (args.mode ?? 'region') as Way, shortcut = String(args.shortcut ?? '');
        if (way === 'region' && !shortcut) throw 'Capture Region always has a shortcut.';
        const other = (Object.keys(WAY_NAMES) as Way[]).find(w => w !== way && shortcut && shortcutOf(w) === shortcut);
        if (other) throw `${WAY_NAMES[other]} already uses ${prettyShortcut(shortcut)}.`;
        state.settings = way === 'region' ? { ...state.settings, shortcut }
          : { ...state.settings, shortcuts: { ...state.settings.shortcuts, [way]: shortcut || undefined } };
        showTrayShortcuts();
        emit('settings-changed', state.settings); return state.settings;
      }
      case 'login_enabled': return false;
      case 'set_login': throw 'Opening at login is a Mac feature; this web preview can\'t.';
      // Kept for the visit, so each choice stays as it was made; the Mac app acts on them.
      // As lib.rs: installing by itself means looking by itself, and not looking means not installing.
      case 'set_auto_update':
        state.settings = { ...state.settings, checkUpdates: Boolean(args.enabled),
                           installUpdates: Boolean(args.enabled) && state.settings.installUpdates };
        return state.settings;
      case 'set_install_updates':
        state.settings = { ...state.settings, installUpdates: Boolean(args.enabled),
                           checkUpdates: Boolean(args.enabled) || state.settings.checkUpdates };
        return state.settings;
      case 'set_show_in_dock': state.settings = { ...state.settings, showInDock: Boolean(args.show) }; return state.settings;
      // Kept for the visit, as the app keeps it for good: the next capture is framed the same.
      case 'set_frame': state.settings = { ...state.settings, frame: args.frame }; return state.settings;
      // What follows a capture, and AI tools: the Mac app's. The demo keeps
      // opening the editor, and nothing outside this page can reach it.
      case 'set_after_capture':
        if (args.value === 'thumbnail') throw 'The thumbnail floats over your other apps, so it is the Mac app\'s. This web demo always opens the editor.';
        state.settings = { ...state.settings, afterCapture: 'editor' }; return state.settings;
      case 'set_mcp': state.settings = { ...state.settings, mcp: Boolean(args.enabled) }; return state.settings;
      case 'mcp_setup': throw 'AI tools reach Mark on your Mac, so the lines to set them up are in the Mac app\'s settings.';
      // The guide is beside the demo on the site, and opens there.
      case 'open_guide': window.open(new URL('ai.html', location.href), '_blank', 'noopener'); return;
      case 'send_capture': {
        if (state.request?.id !== Number(args.id)) throw 'That request has ended, so nothing was sent.';
        state.request = null;
        showSent(String(args.png), String(args.text));
        state.capture = null; state.error = null; editorWanted = false;
        showEditor(false); emitTo(editorFrame, 'capture-changed'); stopTips();
        showHint('Sent. On the right is what Claude received: the picture, and in words what you marked and where.');
        return;
      }
      case 'decline_request':
        if (state.request?.id === Number(args.id)) state.request = null;
        emitTo(editorFrame, 'capture-changed');
        showHint('Claude was told no, and not to ask again unless you say so.');
        return;
      // A real recording, of this desktop rather than your screen, in any browser that can make a movie.
      case 'recording_supported': return canRecord();
      case 'recording_status': return recordingStatus();
      case 'stop_recording': if (!live) throw 'Nothing is recording.'; await finishRecording(true); return;
      case 'discard_recording': if (!live) throw 'Nothing is recording.'; await finishRecording(false); return;
      case 'fit_to_recording':
        recordingFit = [Number(args.width), Number(args.height)];
        if (!editorWin.hidden) fitEditor();
        return;
      case 'video_frames': {
        const { thumbs } = takeOf(args.id), count = Math.max(1, Math.min(24, Number(args.count ?? 10)));
        return Array.from({ length: Math.min(count, thumbs.length) }, (_, i) => thumbs[Math.floor(i * thumbs.length / Math.min(count, thumbs.length))]);
      }
      case 'video_pointer': {
        const take = takeOf(args.id);
        return { track: take.track, presses: take.presses, look: take.look, zoom: take.zoom };
      }
      // A browser's clipboard takes neither, so the card holds the file, and the status line says why.
      case 'copy_video': {
        const blob = await movieFile(args);
        showClipFile(blob, movieName(`${stamp()}.mp4`, blob));
        throw 'A browser can’t put a video on the clipboard, so it’s here to save. In the Mac app, Copy pastes it into a message.';
      }
      case 'copy_gif': {
        const blob = await gifFile(args);
        showClipFile(blob, String(args.name));
        throw 'A browser can’t put a GIF on the clipboard, so it’s here to save. In the Mac app, Copy as GIF pastes it anywhere.';
      }
      case 'save_video': {
        const blob = args.gif ? await gifFile(args) : await movieFile(args);
        const name = args.gif ? String(args.name) : movieName(String(args.name), blob);
        saveFile(blob, name);
        return { name, bytes: blob.size };
      }
      case 'share_video': {
        const blob = await movieFile(args), name = movieName(`${stamp()}.mp4`, blob);
        const file = new File([blob], name, { type: blob.type });
        if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }).catch(() => {}); return; }
        saveFile(blob, name); return;
      }
      case 'set_record_options':
        state.settings = { ...state.settings, recordMic: Boolean(args.mic ?? state.settings.recordMic),
                           recordZoom: Boolean(args.zoom ?? state.settings.recordZoom),
                           recordingPointer: String(args.pointer ?? state.settings.recordingPointer ?? 'arrow'),
                           recordingClicks: String(args.clicks ?? state.settings.recordingClicks ?? 'rings') };
        return state.settings;
      case 'recognize_text': throw 'Copy Text reads the image with the Mac\'s own text recognition, so it works in the Mac app.';
      case 'scan_image': throw 'Hide Sensitive reads the image with the Mac\'s own text and face recognition, so it works in the Mac app.';
      // The web demo is always the newest Mark.
      case 'pending_update': case 'check_for_update': return null;
      case 'open_updates': showHint('The Mac app checks for updates and installs them. This web demo is always the newest version.'); return;
      // The window plugin, as the settings page uses it.
      case 'plugin:app|version': return `${pkg.version} (web demo)`;
      case 'plugin:event|emit': emit(String(args.event), args.payload ?? null); return;
      default: throw `The web demo has no ${command}.`;
    }
  },
};
(window as Window & { __markDemo?: DemoHost }).__markDemo = host;

/** As lib.rs does: Settings are a view of the editor's, so the editor comes
 *  forward and is asked to show them. */
function openSettings() {
  editorWanted = true; showEditor(true); showHint(null);
  emitTo(editorFrame, 'open-settings');
}

// ---- the menu bar ----------------------------------------------------------
function tickClock() {
  $<HTMLElement>('.clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
tickClock(); setInterval(tickClock, 15_000);
/** The tray menu's five ways in, each showing its shortcut if it has one. */
function showTrayShortcuts() {
  const acts: Record<Way, string> = { region: 'capture', window: 'window', display: 'display', timed: 'timed', record: 'record' };
  for (const way of Object.keys(acts) as Way[]) {
    const shortcut = shortcutOf(way);
    trayMenu.querySelector(`[data-act="${acts[way]}"] kbd`)!.textContent = shortcut ? prettyShortcut(shortcut) : '';
  }
}
showTrayShortcuts();

function toggleTray(open?: boolean) {
  const show = open ?? trayMenu.hidden;
  trayMenu.hidden = !show; tray.setAttribute('aria-expanded', String(show));
}
tray.addEventListener('click', () => toggleTray());
trayMenu.addEventListener('click', event => {
  const act = (event.target as Element).closest<HTMLButtonElement>('[data-act]')?.dataset.act;
  toggleTray(false);
  if (act === 'capture') void startWay('region');
  if (act === 'window') void startWay('window');
  if (act === 'display') void startWay('display');
  if (act === 'timed') void startWay('timed');
  if (act === 'record') void startWay('record');
  if (act === 'show') { editorWanted = true; showEditor(true); showHint(null); emitTo(editorFrame, 'capture-changed'); }
  if (act === 'settings') openSettings();
  if (act === 'quit') void host.invoke('quit_app', {}, window, 'page');
});
document.addEventListener('click', event => { if (!trayMenu.hidden && !(event.target as Element).closest('.menubar-right, .tray-menu')) toggleTray(false); });
for (const button of document.querySelectorAll<HTMLButtonElement>('.win .light.close')) {
  button.addEventListener('click', () => {
    void host.invoke('dismiss_editor', {}, window, 'page').catch(() => {});
  });
}
window.addEventListener('keydown', e => {
  if (host.key(e)) { e.preventDefault(); return; }
  if (e.key === 'Escape' && overlay) { e.preventDefault(); (overlay.contentWindow as DemoFrame | null)?.__markDemoEmit?.('demo-escape', null); }
});

// ---- fit the stage to the page --------------------------------------------
/** The desktop is 16:10 and reads best around 1200-1440 wide. Narrower than
 *  1000 it is drawn at 1000 and scaled down, so Mark's minimum window still
 *  fits; the frames keep their own coordinates, which is what makes that safe. */
function fitStage() {
  const available = document.documentElement.clientWidth - (embedded ? 0 : 32);
  const width = Math.min(1440, Math.max(1000, available));
  const scale = Math.min(1, available / width);
  const height = Math.round(width * 10 / 16);
  stage.style.width = `${width}px`; stage.style.height = `${height}px`;
  stage.style.transform = scale < 1 ? `scale(${scale})` : '';
  // The box takes the stage's scaled size, so the caption follows the picture and not the unscaled layout.
  const box = stage.parentElement!;
  box.style.width = `${Math.round(width * scale)}px`; box.style.height = `${Math.round(height * scale)}px`;
  if (!editorWin.hidden) fitEditor();
}
fitStage(); window.addEventListener('resize', fitStage);
showEditor(true);
showHint(`Click the Mark icon in the menu bar, or press ${prettyShortcut(state.settings.shortcut)}, to capture a region of this desktop.`);
