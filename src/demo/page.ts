/** The web demo: a Mac desktop drawn in a page, with Mark running on it.
 *
 *  The desktop is a picture. Mark is not: the editor, the selection overlay
 *  and settings are the real pages, each in a frame, running their native
 *  code path against this file, which plays lib.rs -- it keeps the capture,
 *  crops the scene where the overlay says, sizes the editor's window the way
 *  fit_window does, copies to the clipboard, and answers settings. What cannot
 *  be done in a browser (Liquid Glass, real screen capture, login items) is
 *  said so, not faked. */
import './page.css';
import pkg from '../../package.json';
import { DEFAULT_SHORTCUT, prettyShortcut, shortcutFromEvent } from '../shortcut';
import type { DemoFrame, DemoHost } from './bridge';

// ---- geometry, mirroring lib.rs ------------------------------------------
const CHROME = 46 + 48 + 10 + 10 + 60;
const SIDES = 12 + 10 + 12;
const RAIL = 44;
const RAIL_HEIGHT = 316 + 8 + RAIL + 6;   // the tool pane, the gap, the crop pane, and air beneath
const COMPACT: [number, number] = [560, CHROME + RAIL_HEIGHT];
/** The app's own shortcut. Browsers use ⌘-digit for their tabs, but it is not
 *  among the keys they refuse to hand a page, so the demo takes it and stops it
 *  going further; the menu-bar icon is there for any browser that disagrees. */
const DEMO_SHORTCUT = DEFAULT_SHORTCUT;

interface Capture { dataUrl: string; width: number; height: number; scale: number }
interface Settings { appearance: 'dark' | 'light' | 'system'; shortcut: string }

const state = {
  capture: null as Capture | null, busy: false, error: null as string | null,
  settings: { appearance: 'dark', shortcut: DEMO_SHORTCUT } as Settings,
  armedDelay: 0,
};

/** In the site's frame the page is the desktop and nothing else: no caption,
 *  no margin, and the frame around it is the host's to draw. */
const embedded = new URLSearchParams(location.search).has('embed');
document.documentElement.classList.toggle('embedded', embedded);

// ---- the page --------------------------------------------------------------
document.body.innerHTML = `
  <div class="stage-box"><div class="stage">
    <img class="scene" src="./demo/scene.jpg" alt="" draggable="false" />
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
    <div class="win settings" hidden>
      <div class="titlebar"><span class="lights"><button class="light close" type="button" aria-label="Close"></button><i></i><i></i></span>Mark Settings</div>
      <iframe class="frame" title="Mark Settings"></iframe>
    </div>
    <div class="hint"><span></span></div>
    <aside class="clip" hidden aria-live="polite">
      <img class="clip-image" alt="The image that was copied" />
      <div class="clip-text"><strong></strong><small class="clip-meta"></small></div>
      <div class="clip-actions">
        <button class="clip-save" type="button">Save PNG</button>
        <button class="clip-close" type="button" aria-label="Dismiss">×</button>
      </div>
    </aside>
  </div></div>
  <p class="caption">This is Mark's real editor, selection overlay and settings, running in your browser against a stand-in for the Mac.
    Capturing takes a region of this picture of a desktop; Copy puts a real PNG on your clipboard. Liquid Glass, capturing your actual
    screen, and opening at login need the Mac app.</p>`;

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const stage = $<HTMLDivElement>('.stage');
const editorWin = $<HTMLDivElement>('.win.editor'), editorFrame = editorWin.querySelector('iframe')!;
const settingsWin = $<HTMLDivElement>('.win.settings'), settingsFrame = settingsWin.querySelector('iframe')!;
const tray = $<HTMLButtonElement>('.tray'), trayMenu = $<HTMLDivElement>('.tray-menu');
const countdown = $<HTMLElement>('.countdown'), hint = $<HTMLElement>('.hint span');
let overlay: HTMLIFrameElement | null = null;
let editorWanted = true;   // whether the editor should be on screen when nothing else is happening

const frames = (): DemoFrame[] => [editorFrame, settingsFrame, overlay].flatMap(f => f?.contentWindow ? [f.contentWindow as DemoFrame] : []);
const emit = (event: string, payload: unknown = null) => { for (const f of frames()) f.__markDemoEmit?.(event, payload); };
const emitTo = (frame: HTMLIFrameElement, event: string, payload: unknown = null) => (frame.contentWindow as DemoFrame | null)?.__markDemoEmit?.(event, payload);

// ---- the scene, and cropping it -------------------------------------------
const scene = $<HTMLImageElement>('.scene');
const sceneReady = scene.complete ? Promise.resolve() : new Promise<void>(resolve => scene.addEventListener('load', () => resolve(), { once: true }));
/** Scene pixels per stage point: the picture is 2x of a 1440-wide desktop, shown at whatever width the page allows. */
const sceneScale = () => scene.naturalWidth / stage.offsetWidth;

async function crop(x: number, y: number, width: number, height: number): Promise<Capture> {
  await sceneReady;
  const s = sceneScale();
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * s)); canvas.height = Math.max(1, Math.round(height * s));
  canvas.getContext('2d')!.drawImage(scene, Math.round(x * s), Math.round(y * s), canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, scale: s };
}

// ---- windows ---------------------------------------------------------------
/** fit_window: the capture at actual size where the stage allows, compact when empty. */
function fitEditor() {
  let [w, h] = state.capture
    ? [state.capture.width / state.capture.scale + SIDES + RAIL, state.capture.height / state.capture.scale + CHROME]
    : COMPACT;
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

// ---- tips ------------------------------------------------------------------
/** With a capture open, the pill teaches one thing at a time, in about the order
 *  a first drawing raises them. Nothing here is invented for the demo: each is
 *  something the app does. */
const TIPS = [
  'Drag to draw. The tip of an arrow lands exactly where you let go.',
  'Three arrow styles sit beside the colours: tapered, solid and thin.',
  'Drag an arrow\'s end to reshape it, or its body to move it.',
  '⌘Z takes the last thing back, a crop included.',
  'Redact pixelates rather than blurs: a blur can be undone.',
  'Shift-click gathers several annotations; they then move and restyle together.',
  'Crop keeps the drawing, shifted to match. ⌘Z puts the whole capture back.',
  '⌘C copies the image and closes. ⌘⇧C copies and keeps working.',
  'Closed a capture by accident? Recent, on the empty state, holds the last six.',
];
const TIP_EVERY = 6500;
let tipTimer: number | undefined, tipIndex = 0;
function showTip() {
  const which = tipIndex++ % TIPS.length;
  showHint(TIPS[which]); hint.parentElement!.dataset.tip = String(which);
}
function startTips() { stopTips(); tipIndex = 0; showTip(); tipTimer = window.setInterval(showTip, TIP_EVERY); }
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
let clipPng = '';
function showClip(png: string, refused: string | null) {
  clipPng = png;
  clipImage.src = `data:image/png;base64,${png}`;
  clipImage.onload = () => { clipMeta.textContent = `${clipImage.naturalWidth} × ${clipImage.naturalHeight} px`; };
  clip.querySelector('strong')!.textContent = refused ? 'The browser refused the copy' : 'On your clipboard';
  clip.classList.toggle('refused', refused !== null);
  clip.hidden = false;
  clip.classList.remove('in'); void clip.offsetWidth; clip.classList.add('in');   // the entrance again, for a second copy
}
/** The name macOS gives a screenshot, as the app's Save suggests. */
function suggestedName(): string {
  const now = new Date(), pad = (value: number) => String(value).padStart(2, '0');
  return `Mark ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + ` at ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}.png`;
}
clip.querySelector('.clip-save')!.addEventListener('click', () => download(clipPng, suggestedName()));
clip.querySelector('.clip-close')!.addEventListener('click', () => { clip.hidden = true; });
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
async function beginSelection(delay: number) {
  if (state.busy) return;
  state.busy = true; state.armedDelay = delay; state.error = null;
  emitTo(editorFrame, 'capture-changed');
  showEditor(false); settingsWin.hidden = true; stopTips(); showHint(null);
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

async function tick(seconds: number) {
  for (let left = seconds; left > 0; left--) {
    countdown.hidden = false; countdown.textContent = `${left}`;
    await new Promise(r => setTimeout(r, 1000));
  }
  countdown.hidden = true;
}

async function took(capture: Capture) {
  state.capture = capture; state.error = null;
  editorWanted = true;
  showEditor(true);
  emitTo(editorFrame, 'capture-changed');
  startTips();
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
function download(base64: string, name: string) {
  const url = URL.createObjectURL(pngBlob(base64));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---- appearance ------------------------------------------------------------
function applyAppearance() {
  const theme = state.settings.appearance === 'system' ? '' : state.settings.appearance;
  // The page too: the window wrappers stand in for the Mac's material, which follows the appearance.
  for (const doc of [document, editorFrame.contentDocument, settingsFrame.contentDocument, overlay?.contentDocument]) {
    if (!doc) continue;
    if (theme) doc.documentElement.dataset.theme = theme; else delete doc.documentElement.dataset.theme;
  }
}
for (const f of [editorFrame, settingsFrame]) f.addEventListener('load', applyAppearance);

// ---- the part of lib.rs the frames talk to ---------------------------------
export const host: DemoHost & { display(): { x: number; y: number; width: number; height: number; scale: number }; delay(): number; beginDrag(label: string, x: number, y: number): void; endDrag(): void; key(e: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean } = {
  display: () => ({ x: 0, y: 0, width: stage.offsetWidth, height: stage.offsetHeight, scale: sceneScale() }),
  delay: () => state.armedDelay,
  beginDrag(label, x, y) { beginDrag(label === 'settings' ? settingsWin : editorWin, x, y); },
  endDrag,
  key(e) {
    if (shortcutFromEvent(e) !== state.settings.shortcut) return false;
    void beginSelection(0); return true;
  },
  async invoke(command, args) {
    switch (command) {
      case 'current_capture': return { capture: state.capture, error: state.error, busy: state.busy };
      case 'capture_region': await beginSelection(Number(args.delay ?? 0)); return;
      case 'capture_display': {
        state.busy = true; emitTo(editorFrame, 'capture-changed'); showEditor(false);
        await tick(Number(args.delay ?? 0));
        const whole = await crop(0, 0, stage.offsetWidth, stage.offsetHeight);
        state.busy = false; await took(whole); return;
      }
      case 'capture_rect': {
        overlay?.remove(); overlay = null;
        await tick(Number(args.delay ?? 0));
        const region = await crop(Number(args.x), Number(args.y), Number(args.width), Number(args.height));
        state.busy = false; await took(region); return;
      }
      case 'cancel_selection': endSelection(); if (editorWanted) showEditor(true); emitTo(editorFrame, 'capture-changed'); return;
      case 'copy_capture': {
        if (!state.capture) throw 'Nothing to copy yet.';
        await copied(state.capture.dataUrl.split(',')[1], Boolean(args.close)); return;
      }
      case 'copy_edited': await copied(String(args.png), Boolean(args.close)); return;
      case 'save_image': download(String(args.png), String(args.name)); return String(args.name);
      case 'share_image': {
        const file = new File([pngBlob(String(args.png))], String(args.name), { type: 'image/png' });
        if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }).catch(() => {}); return; }
        download(String(args.png), String(args.name)); return;
      }
      case 'dismiss_editor': {
        if (state.busy) throw 'Press Escape to cancel the selection first.';
        state.capture = null; state.error = null; editorWanted = false;
        showEditor(false); emitTo(editorFrame, 'capture-changed'); stopTips();
        showHint(`Closed. Click the Mark icon in the menu bar, or press ${prettyShortcut(state.settings.shortcut)}, to capture again.`);
        return;
      }
      case 'open_screen_settings': return;
      case 'quit_app': {
        editorWanted = false; showEditor(false); settingsWin.hidden = true; endSelection(); stopTips();
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
        state.settings = { ...state.settings, shortcut: String(args.shortcut) };
        trayMenu.querySelector('[data-act="capture"] kbd')!.textContent = prettyShortcut(state.settings.shortcut);
        emit('settings-changed', state.settings); return state.settings;
      }
      case 'login_enabled': return false;
      case 'set_login': throw 'Opening at login is a Mac feature; this web preview can\'t.';
      case 'open_settings': openSettings(); return;
      // The window plugin, as the settings page uses it.
      case 'plugin:window|close': settingsWin.hidden = true; return;
      case 'plugin:window|set_size': { const size = args.value as { height: number }; settingsFrame.style.height = `${Math.round(size.height)}px`; return; }
      case 'plugin:window|inner_size': return { width: settingsFrame.clientWidth * devicePixelRatio, height: settingsFrame.clientHeight * devicePixelRatio };
      case 'plugin:window|scale_factor': return devicePixelRatio;
      case 'plugin:app|version': return `${pkg.version} (web demo)`;
      case 'plugin:event|emit': emit(String(args.event), args.payload ?? null); return;
      default: throw `The web demo has no ${command}.`;
    }
  },
};
(window as Window & { __markDemo?: DemoHost }).__markDemo = host;

function openSettings() {
  if (!settingsFrame.src) settingsFrame.src = './demo/settings.html';
  settingsWin.hidden = false;
  settingsWin.style.width = '460px';
  if (!settingsWin.dataset.moved) {
    settingsWin.style.left = `${Math.round((stage.offsetWidth - 460) / 2 + 40)}px`;
    settingsWin.style.top = `${Math.round(Math.max(60, stage.offsetHeight / 2 - 160))}px`;
  }
  raise(settingsWin);
}

// ---- the menu bar ----------------------------------------------------------
function tickClock() {
  $<HTMLElement>('.clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
tickClock(); setInterval(tickClock, 15_000);
trayMenu.querySelector('[data-act="capture"] kbd')!.textContent = prettyShortcut(state.settings.shortcut);

function toggleTray(open?: boolean) {
  const show = open ?? trayMenu.hidden;
  trayMenu.hidden = !show; tray.setAttribute('aria-expanded', String(show));
}
tray.addEventListener('click', () => toggleTray());
trayMenu.addEventListener('click', event => {
  const act = (event.target as Element).closest<HTMLButtonElement>('[data-act]')?.dataset.act;
  toggleTray(false);
  if (act === 'capture') void beginSelection(0);
  if (act === 'show') { editorWanted = true; showEditor(true); showHint(null); emitTo(editorFrame, 'capture-changed'); }
  if (act === 'settings') openSettings();
  if (act === 'quit') void host.invoke('quit_app', {}, window, 'page');
});
document.addEventListener('click', event => { if (!trayMenu.hidden && !(event.target as Element).closest('.menubar-right, .tray-menu')) toggleTray(false); });
for (const button of document.querySelectorAll<HTMLButtonElement>('.win .light.close')) {
  button.addEventListener('click', () => {
    const win = button.closest<HTMLElement>('.win')!;
    if (win === settingsWin) settingsWin.hidden = true;
    else void host.invoke('dismiss_editor', {}, window, 'page').catch(() => {});
  });
}
document.querySelector<HTMLElement>('.win.settings .titlebar')!.addEventListener('mousedown', e => { if ((e.target as Element).closest('.light')) return; beginDrag(settingsWin, e.screenX, e.screenY); });
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
