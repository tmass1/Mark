import './thumbnail.css';
import { command, isTauri } from './platform';
import { suggestedName } from './names';

/** The floating thumbnail's page: the capture just taken, waiting in the
 *  corner of the screen. Rust has the window -- a panel that never takes the
 *  focus -- and the capture; this has the picture, how long it stays, and what
 *  each gesture asks Rust to do. The page never sees the pointer itself, the
 *  window never being key, so Rust says when it comes and goes. */

/** How long it stays when nothing is done with it: about as long as macOS's. */
export const STAYS = 5000;
/** How far a two-finger swipe to the right goes before it sends it away. */
const SWIPE = 56;

interface Shown { id: number; dataUrl: string; width: number; height: number }

const root = document.querySelector<HTMLDivElement>('#thumbnail')!;
root.innerHTML = `
  <figure class="thumb">
    <img class="thumb-image" alt="The capture just taken" draggable="true" />
    <button class="thumb-close" type="button" aria-label="Close" tabindex="-1">
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.6 3.6l4.8 4.8M8.4 3.6l-4.8 4.8"/></svg>
    </button>
  </figure>`;
const figure = root.querySelector<HTMLElement>('.thumb')!;
const image = root.querySelector<HTMLImageElement>('.thumb-image')!;
const close = root.querySelector<HTMLButtonElement>('.thumb-close')!;

let shown: Shown | null = null;
let timer: number | undefined;
let hovering = false;
let dragging = false;
let swiped = 0;
let swipeRest: number | undefined;

/** Count down to going, unless something holds it: the pointer on it, or a
 *  drag under way. Each time the hold ends, the count starts again. */
function count() {
  window.clearTimeout(timer);
  if (!shown || hovering || dragging) return;
  timer = window.setTimeout(() => go(), STAYS);
}

/** Away, sliding off to the right the way it came; then Rust takes it down,
 *  and the capture waits in Recent. */
function go(at = 220) {
  if (!shown) return;
  const id = shown.id;
  shown = null;
  window.clearTimeout(timer);
  figure.style.transform = '';
  figure.classList.remove('in');
  figure.classList.add('out');
  window.setTimeout(() => { void command('close_thumbnail', { id }).catch(() => {}); }, at);
}

/** The picture Rust has for the thumbnail now, slid in from the right. */
async function load() {
  const next = await command<Shown | null>('thumbnail_image').catch(() => null);
  if (!next || next.id === shown?.id) return;
  shown = next;
  hovering = dragging = false;
  swiped = 0;
  root.classList.remove('hover', 'dragging');
  figure.classList.remove('in', 'out');
  figure.style.transform = '';
  image.src = next.dataUrl;
  await image.decode().catch(() => {});
  if (shown !== next) return;
  void figure.offsetWidth;             // from off to the right, every time
  figure.classList.add('in');
  count();
}

image.addEventListener('click', () => {
  if (!shown) return;
  const id = shown.id;
  shown = null;
  window.clearTimeout(timer);
  // Out of the picture at once, as every other way of going is: the window is
  // reused, and must never show this one again while the next loads.
  figure.classList.remove('in');
  figure.classList.add('out');
  void command('open_thumbnail', { id }).catch(() => {});
});

close.addEventListener('click', event => { event.stopPropagation(); go(); });

image.addEventListener('dragstart', event => {
  // First, before anything else: a drag WebKit started itself would carry the
  // page's picture rather than the file.
  event.preventDefault();
  if (!shown) return;
  const box = image.getBoundingClientRect();
  dragging = true;
  root.classList.add('dragging');
  count();
  void command('drag_thumbnail', { id: shown.id, name: suggestedName(), x: box.x, y: box.y, width: box.width, height: box.height })
    .catch(() => { dragging = false; root.classList.remove('dragging'); count(); });
});

// A swipe to the right sends it away, as macOS's does: the fingers moving
// right, whichever way this Mac scrolls. It follows the fingers until then,
// and springs back if they stop short.
root.addEventListener('wheel', event => {
  if (!shown || dragging) return;
  event.preventDefault();
  const natural = (event as WheelEvent & { webkitDirectionInvertedFromDevice?: boolean }).webkitDirectionInvertedFromDevice ?? true;
  swiped = Math.max(0, swiped + (natural ? -event.deltaX : event.deltaX));
  window.clearTimeout(swipeRest);
  if (swiped > SWIPE) { swiped = 0; go(160); return; }
  figure.style.transform = swiped ? `translateX(${swiped}px)` : '';
  swipeRest = window.setTimeout(() => { swiped = 0; figure.style.transform = ''; }, 180);
}, { passive: false });

async function listen<T>(event: string, handler: (payload: T) => void) {
  const { listen } = await import('@tauri-apps/api/event');
  await listen<T>(event, message => handler(message.payload));
}

async function init() {
  if (!isTauri) return;
  await listen<number>('thumbnail-show', () => { void load(); });
  await listen<boolean>('thumbnail-hover', inside => {
    hovering = inside;
    root.classList.toggle('hover', inside);
    count();
  });
  await listen<boolean>('thumbnail-dropped', landed => {
    dragging = false;
    root.classList.remove('dragging');
    // Dropped somewhere, its job is done; let go over nothing, it stays.
    if (landed) go(0); else count();
  });
  // Made just now for a capture already waiting: ask for it.
  await load();
}
void init();
