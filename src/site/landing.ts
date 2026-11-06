/** The landing page. It's written in site.html; this fills in what the app itself knows, runs the
 *  demo in its frame, and draws every mark on the page with the app's own layer, so a mark here
 *  can't come to misrepresent one in the editor. What moves as you scroll is motion.ts's. */
import { AnnotationLayer, arrowPolygon, arrowStrokes, polygonPath, showsAt, strokePath, type Annotation, type Arrow, type ArrowStyle, type Step, type Tool } from '../annotations';
import { NOTE_STYLES, NOTE_STYLE_NAMES, type NoteStyle } from '../note-style';
import { DEFAULT_SHORTCUT, prettyShortcut } from '../shortcut';
import { drawPageArrows } from './arrows';
import BOARD from './board.json';
import { all, copyButtons, one, showAppFacts } from './facts';
import { startMotion, type CaptureStage } from './motion';

const RED = '#ff3b30';
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- what the app knows ---------------------------------------------------------
showAppFacts();
copyButtons();
// The Mac gets the download line; anyone else is told what they are looking at.
const platform = `${(navigator as { userAgentData?: { platform: string } }).userAgentData?.platform ?? ''} ${navigator.platform}`;
document.documentElement.classList.toggle('elsewhere', !/Mac/i.test(platform));

// ---- the bar ---------------------------------------------------------------------
const bar = one('#bar');
const stick = () => bar.classList.toggle('stuck', scrollY > 24);
addEventListener('scroll', stick, { passive: true });
stick();

// ---- who it's for: the headline's chip names one person after another ------------------
const GLYPH = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
const GLYPHS: Record<string, string> = {
  // Who a mock-up goes to: an agent's terminal, two people, a designer's pencil, a speech bubble.
  agent: `<rect x="2.8" y="3.6" width="14.4" height="12.8" rx="2.2" ${GLYPH}/><path d="M6.4 8.2 8.8 10l-2.4 1.8M10.8 12.2h3" ${GLYPH}/>`,
  people: `<circle cx="7.6" cy="7.4" r="2.6" ${GLYPH}/><path d="M2.9 16.2c.4-2.7 2.3-4.3 4.7-4.3s4.3 1.6 4.7 4.3" ${GLYPH}/><circle cx="13.9" cy="8" r="2.1" ${GLYPH}/><path d="M13.6 12.1c2 0 3.5 1.4 3.9 3.6" ${GLYPH}/>`,
  pen: `<path d="M12.9 3.9 16.1 7.1 7.4 15.8 3.6 16.4l.6-3.8z" ${GLYPH}/><path d="M11.1 5.7l3.2 3.2" ${GLYPH}/>`,
  ask: `<path d="M4.4 4.2h11.2a1.6 1.6 0 0 1 1.6 1.6v6.6a1.6 1.6 0 0 1-1.6 1.6H9.4l-3.6 2.9v-2.9H4.4a1.6 1.6 0 0 1-1.6-1.6V5.8a1.6 1.6 0 0 1 1.6-1.6z" ${GLYPH}/><path d="M6.8 9.1h6.4" ${GLYPH}/>`,
};
const glyph = (name: string) => `<svg viewBox="0 0 20 20" aria-hidden="true">${GLYPHS[name] ?? ''}</svg>`;
for (const el of all('[data-glyph]')) el.innerHTML = glyph(el.dataset.glyph!);
const PEOPLE = [
  { who: 'agent', name: 'AI agent', glyph: 'agent' }, { who: 'coworker', name: 'Co-worker', glyph: 'people' },
  { who: 'designer', name: 'Designer', glyph: 'pen' }, { who: 'friend', name: 'Friend', glyph: 'ask' },
];
// Only while it can be seen, and anyone who asks for less motion keeps the agent.
if (!calm) {
  const chip = one('.who'), icon = one('i', chip), name = one('span', chip);
  let at = 0, chipSeen = true;
  new IntersectionObserver(([entry]) => { chipSeen = entry.isIntersecting; }).observe(chip);
  // The width is held only while it eases, so a font arriving late still fits.
  chip.addEventListener('transitionend', event => { if (event.propertyName === 'width') chip.style.width = ''; });
  setInterval(() => {
    if (!chipSeen || document.hidden) return;
    const from = chip.getBoundingClientRect().width;
    chip.classList.add('out');
    setTimeout(() => {
      at = (at + 1) % PEOPLE.length;
      chip.dataset.who = PEOPLE[at].who;
      icon.innerHTML = glyph(PEOPLE[at].glyph);
      name.textContent = PEOPLE[at].name;
      chip.classList.replace('out', 'in');
      chip.style.width = '';
      const to = chip.getBoundingClientRect().width;
      chip.style.width = `${from}px`;
      chip.getBoundingClientRect();
      chip.style.width = `${to}px`;
      requestAnimationFrame(() => chip.classList.remove('in'));
    }, 190);
  }, 2400);
}

// ---- the demo, only in a window wide enough to show it ------------------------------------
// A frame that is hidden but has a source is loaded all the same -- a lazy one too, since a hidden
// frame is taken for a tracker and fetched at once -- so the source waits for a width that shows it.
const demo = one<HTMLIFrameElement>('.demo'), tryMe = one('.try-me');
const wide = matchMedia('(min-width: 721px)');
const startDemo = () => {
  if (!wide.matches || !demo.dataset.src) return;
  demo.src = demo.dataset.src;
  demo.removeAttribute('data-src');
  wide.removeEventListener('change', startDemo);
};
wide.addEventListener('change', startDemo);
// After the page itself has loaded, so the demo doesn't hold it up.
if (document.readyState === 'complete') startDemo(); else addEventListener('load', startDemo, { once: true });
// The callout goes once the demo's been used. A click into it moves the focus into its frame,
// which the page hears as its own window losing focus, with the frame left holding it.
const used = () => setTimeout(() => {
  if (document.activeElement !== demo) return;
  tryMe.classList.add('used');
  removeEventListener('blur', used);
});
addEventListener('blur', used);
// The demo says ⌘4 starts a capture, so while it's in view its shortcuts are its own.
let demoInView = false;
new IntersectionObserver(([entry]) => { demoInView = entry.isIntersecting; }, { threshold: .4 }).observe(demo);
addEventListener('keydown', event => {
  const inside = demo.contentWindow as (Window & { __markDemo?: { key?(e: KeyboardEvent): boolean } }) | null;
  if (!demoInView || !inside?.__markDemo?.key?.(event)) return;
  event.preventDefault();
  tryMe.classList.add('used');
});
// "Let an agent ask" and "Record a video": up to the demo, where an agent -- played by the demo --
// asks for a screenshot, as it asks the app through its MCP server, or Record opens as in the app.
for (const [selector, message] of [['[data-ask]', 'mark-demo:ask'], ['[data-record]', 'mark-demo:record']]) {
  for (const button of all(selector)) button.addEventListener('click', () => {
    tryMe.classList.add('used');
    demo.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'center' });
    const ask = () => demo.contentWindow?.postMessage(message, location.origin);
    // A demo still loading asks once it has; the editor reads the ask when it starts.
    if (demo.contentDocument?.readyState === 'complete' && demo.getAttribute('src')) ask();
    else demo.addEventListener('load', ask, { once: true });
  });
}

// ---- how long the paragraph really is --------------------------------------------------
one('#typed-count').textContent = `${(one('#typed').textContent ?? '').trim().split(/\s+/).length} words`;

// ---- a picture marked up by the app's own layer ----------------------------------------
const step = (id: number, x: number, y: number, to: [number, number], note: string, weight: number): Step => ({ kind: 'step', id, x, y, to, note, style: 'mark', color: RED, weight });
// A mark's paints and shadows are found by id across the whole page, so each drawing keeps to ids of its own.
const OVERVIEW = [
  step(301, 600, 50, [1206, 54], 'Add an “All time” range', 16.6),
  step(302, 400, 484, [1078, 492], 'Show the day’s total on hover', 16.6),
  step(303, 100, 804, [718, 702], 'Label the dashed line “Last year”', 16.6),
];
document.fonts.ready.then(() => {
  const copied = new AnnotationLayer(one<SVGSVGElement>('#copied-marks'), document.createElement('div'), () => {});
  copied.setImage(1720, 884);
  copied.notes = 'framed';
  copied.load(OVERVIEW);
});

// ---- 1: capture -------------------------------------------------------------------------
const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
const MODES = [
  { mode: 'region', name: 'Region', does: 'Drag out part of the screen', hint: prettyShortcut(DEFAULT_SHORTCUT), art: `<path d="M4.4 7.7V5.9a1.5 1.5 0 0 1 1.5-1.5h1.8M12.3 4.4h1.8a1.5 1.5 0 0 1 1.5 1.5v1.8M15.6 12.3v1.8a1.5 1.5 0 0 1-1.5 1.5h-1.8M7.7 15.6H5.9a1.5 1.5 0 0 1-1.5-1.5v-1.8" ${STROKE}/>`, tip: 'Drag out the part of the screen to capture' },
  { mode: 'window', name: 'Window', does: 'Click one, even if it’s covered', hint: 'Space', art: `<rect x="3.2" y="4.4" width="13.6" height="11.2" rx="1.8" ${STROKE}/><path d="M3.2 7.8h13.6" ${STROKE}/><circle cx="5.6" cy="6.1" r=".7" fill="currentColor"/><circle cx="7.6" cy="6.1" r=".7" fill="currentColor"/>`, tip: 'Click a window to capture it, whole even where it is covered' },
  { mode: 'display', name: 'Whole Screen', does: 'The whole display, right away', hint: '', art: `<rect x="3.2" y="4.5" width="13.6" height="9.6" rx="1.8" fill="currentColor" opacity=".16"/><rect x="3.2" y="4.5" width="13.6" height="9.6" rx="1.8" ${STROKE}/><path d="M7.6 16.6h4.8" ${STROKE}/>`, tip: 'Capture the whole screen the pointer is on, straight away' },
  { mode: 'timed', name: 'Timed Region', does: 'A region, five seconds later', hint: '5s', art: `<circle cx="10" cy="11.4" r="5.4" ${STROKE}/><path d="M10 8.4v3l2.1 1.3M8.1 3.4h3.8M10 3.4v2.6" ${STROKE}/>`, tip: 'Clicks go straight through while you set up' },
  { mode: 'record', name: 'Record Video', does: 'Part of the screen, a window or all of it', hint: '', art: `<circle cx="10" cy="10" r="6.4" ${STROKE}/><circle cx="10" cy="10" r="3.2" fill="currentColor"/>`, tip: 'One bar for the microphone, delay, pointer and clicks' },
];
// When the scroll is driving these (motion.ts), a row or the keys scroll to their place instead.
const scrolling: CaptureStage['scrolling'] = { jump: null };
const grab = one('#grab'), marquee = one('#marquee'), reading = one('#reading'), hint = one('#hint'), flash = one('#flash'), count = one('#count');
const modes = one('#modes');
modes.innerHTML = MODES.map(({ mode, name, does, hint: key, art }) => `<button class="mode" type="button" data-mode="${mode}" aria-pressed="${mode === 'region'}"><svg viewBox="0 0 20 20" aria-hidden="true">${art}</svg><b>${name}</b><i>${does}</i>${key ? `<kbd>${key}</kbd>` : ''}</button>`).join('');

const rectIn = () => {
  const box = grab.getBoundingClientRect(), r = marquee.getBoundingClientRect();
  return { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height, box };
};
// Sizes as the capture has them, in the picture's own pixels.
const readSize = () => { const { w, h, box } = rectIn(), scale = 2880 / box.width; reading.textContent = `${Math.round(w * scale)} × ${Math.round(h * scale)} px`; };
const setRect = (x: number, y: number, w: number, h: number) => {
  const b = grab.getBoundingClientRect();
  Object.assign(marquee.style, { left: `${x / b.width * 100}%`, top: `${y / b.height * 100}%`, width: `${w / b.width * 100}%`, height: `${h / b.height * 100}%` });
  readSize();
};
const clearRect = () => { Object.assign(marquee.style, { left: '', top: '', width: '', height: '' }); readSize(); };
const shutter = () => { flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on'); };

let run = 0;
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const dragOut = async (ticket: number, from = [.4, .24], to = [.82, .74]) => {
  const { box } = rectIn(), started = performance.now(), long = calm ? 1 : 780;
  await new Promise<void>(done => {
    const frame = (now: number) => {
      if (ticket !== run) { done(); return; }
      const t = Math.min(1, (now - started) / long), e = 1 - Math.pow(1 - t, 3);
      setRect(from[0] * box.width, from[1] * box.height, (to[0] - from[0]) * box.width * e + 2, (to[1] - from[1]) * box.height * e + 2);
      if (t < 1) requestAnimationFrame(frame); else done();
    };
    requestAnimationFrame(frame);
  });
};
async function choose(mode: string, play = true) {
  const ticket = ++run, chosen = MODES.find(m => m.mode === mode)!;
  grab.dataset.mode = mode;
  for (const button of all('.mode', modes)) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  hint.textContent = chosen.tip;
  count.textContent = '';
  clearRect();
  if (!play) return;
  if (mode === 'region') { await dragOut(ticket); if (ticket === run) shutter(); }
  if (mode === 'display') { readSize(); shutter(); }
  if (mode === 'record') readSize();
  if (mode === 'timed') {
    for (let left = 5; left > 0 && ticket === run; left--) { count.textContent = String(left); await sleep(calm ? 200 : 720); }
    if (ticket === run) { count.textContent = ''; shutter(); }
  }
}
const modeRows = () => all('.mode', modes);
modes.addEventListener('click', event => {
  const row = (event.target as Element).closest<HTMLElement>('.mode');
  if (!row) return;
  if (scrolling.jump) scrolling.jump(modeRows().indexOf(row)); else void choose(row.dataset.mode!);
});
modes.addEventListener('keydown', event => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const list = modeRows(), at = list.indexOf(document.activeElement as HTMLElement);
  const next = list[(at + (event.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length];
  next.focus();
  if (scrolling.jump) scrolling.jump(list.indexOf(next)); else void choose(next.dataset.mode!);
});
// Drag across the picture for yourself: the reading follows, as it does in the app.
let anchor: [number, number] | null = null;
grab.addEventListener('pointerdown', event => {
  if (grab.dataset.mode !== 'region' && grab.dataset.mode !== 'timed' && grab.dataset.mode !== 'record') return;
  run++;
  const b = grab.getBoundingClientRect();
  anchor = [event.clientX - b.left, event.clientY - b.top];
  grab.setPointerCapture(event.pointerId);
  setRect(anchor[0], anchor[1], 1, 1);
});
grab.addEventListener('pointermove', event => {
  if (!anchor) return;
  const b = grab.getBoundingClientRect(), x = Math.max(0, Math.min(b.width, event.clientX - b.left)), y = Math.max(0, Math.min(b.height, event.clientY - b.top));
  setRect(Math.min(anchor[0], x), Math.min(anchor[1], y), Math.abs(x - anchor[0]) + 1, Math.abs(y - anchor[1]) + 1);
});
grab.addEventListener('pointerup', () => { if (anchor) { anchor = null; shutter(); } });
grab.addEventListener('pointercancel', () => { anchor = null; });
const press = () => {
  const keys = all('[data-press]');
  keys.forEach(key => key.classList.add('down'));
  setTimeout(() => keys.forEach(key => key.classList.remove('down')), 220);
  if (scrolling.jump) scrolling.jump(0); else void choose('region');
};
for (const key of all('[data-press]')) key.addEventListener('click', press);
void choose('region', false);
const grabSeen = new IntersectionObserver(([entry]) => {
  if (entry.isIntersecting) { grabSeen.disconnect(); if (!scrolling.jump) setTimeout(press, 500); }
}, { threshold: .6 });
if (!calm) grabSeen.observe(grab);
// ⌘4 for real, here too, while the picture's in view and the demo isn't.
let grabInView = false;
new IntersectionObserver(([entry]) => { grabInView = entry.isIntersecting; }, { threshold: .5 }).observe(grab);
addEventListener('keydown', event => {
  if (!grabInView || demoInView || !event.metaKey || event.code !== 'Digit4') return;
  event.preventDefault();
  press();
});

// ---- 2: mark it up, with Mark's own layer -----------------------------------------------------
const overlay = one<SVGSVGElement>('#overlay'), picture = one('#picture'), steps = one('#steps'), undo = one<HTMLButtonElement>('#undo');
const WEIGHT = 17;
// Solid red notes: the app's Soft solid style.
const FIRST_LOOK: NoteStyle = 'solid';
const START = [
  step(101, 186, 300, [352, 200], 'Show who hasn’t paid first', WEIGHT),
  step(102, 1020, 530, [1270, 420], 'Add “Send a reminder” here', WEIGHT),
  step(103, 1030, 54, [1610, 54], 'Export only what’s filtered', WEIGHT),
];
let listed = -1;
const syncSteps = () => {
  const numbered = layer.annotations.filter((item): item is Step => item.kind === 'step');
  one('#steps-count').textContent = numbered.length ? String(numbered.length) : '';
  undo.disabled = !layer.canUndo;
  if (numbered.length === listed) return;
  listed = numbered.length;
  steps.innerHTML = numbered.length
    ? numbered.map((item, i) => `<li><span class="n"><span>${i + 1}</span></span><textarea rows="1" data-id="${item.id}" placeholder="What should change?" aria-label="Note ${i + 1}">${item.note ?? ''}</textarea></li>`).join('')
    : '<li class="steps-empty" style="display:block">Drag on the picture to point at something.</li>';
};
const layer = new AnnotationLayer(overlay, picture, () => syncSteps());
layer.setSource(one<HTMLImageElement>('#picture-image'));
layer.setImage(1761, 1130);
layer.base = WEIGHT;
layer.notes = 'framed';
layer.noteStyle = FIRST_LOOK;
layer.style = { ...layer.style, color: RED, numbered: true, arrow: 'mark' };
steps.addEventListener('input', event => {
  const field = event.target as HTMLTextAreaElement, id = Number(field.dataset.id);
  if (id) layer.setNote(id, field.value);
});
layer.onNumbered = id => {
  listed = -1; syncSteps();
  steps.querySelector<HTMLTextAreaElement>(`[data-id="${id}"]`)?.focus();
};
document.fonts.ready.then(() => layer.load(START));

const TOOLS: { id: Tool; name: string; numbered?: boolean; art: string }[] = [
  { id: 'arrow', name: 'Numbered arrow', numbered: true, art: `<path d="M5.5 14.5 14 6M5.5 14.5h5.2M5.5 14.5V9.3" transform="rotate(180 10 10)" ${STROKE}/>` },
  { id: 'box', name: 'Box', art: `<rect x="4.6" y="5.8" width="10.8" height="8.4" rx="1.4" ${STROKE}/>` },
  { id: 'ellipse', name: 'Ellipse', art: `<ellipse cx="10" cy="10" rx="5.6" ry="4.4" ${STROKE}/>` },
  { id: 'pen', name: 'Pen', art: `<path d="M4 12c1.4-3 2.6-4.5 3.6-4.5 1.5 0 .7 5 2.2 5s2-4.5 3.4-4.5c.9 0 1.3 1 2.8 1.5" ${STROKE}/>` },
  { id: 'text', name: 'Text', art: `<path d="M5 6h10M10 6v8.5M7.8 14.5h4.4" ${STROKE}/>` },
  { id: 'redact', name: 'Redact', art: `<rect x="4" y="6" width="4" height="4" fill="currentColor"/><rect x="8" y="10" width="4" height="4" fill="currentColor" opacity=".6"/><rect x="12" y="6" width="4" height="4" fill="currentColor" opacity=".8"/>` },
];
const toolSet = one('#tools');
toolSet.innerHTML = TOOLS.map(({ id, name, art }, i) => `<button type="button" data-tool="${id}" title="${name}" aria-label="${name}" aria-pressed="${!i}"><svg viewBox="0 0 20 20" aria-hidden="true">${art}</svg></button>`).join('');
toolSet.addEventListener('click', event => {
  const chosen = (event.target as Element).closest<HTMLElement>('button');
  if (!chosen) return;
  const tool = TOOLS.find(t => t.id === chosen.dataset.tool)!;
  layer.tool = tool.id;
  layer.style = { ...layer.style, numbered: Boolean(tool.numbered) };
  overlay.classList.toggle('text-tool', tool.id === 'text');
  for (const button of all('button', toolSet)) button.setAttribute('aria-pressed', String(button === chosen));
});

// The choices, drawn by the same functions that draw the marks.
const ARROWS: [ArrowStyle, string][] = [['mark', 'Mark'], ['taper', 'Tapered'], ['straight', 'Solid'], ['line', 'Thin']];
const arrowSet = one('#arrows');
arrowSet.innerHTML = ARROWS.map(([style, name], i) => {
  const a: Arrow = { kind: 'arrow', id: i, style, x1: 3, y1: 17, x2: 17, y2: 3, color: '', weight: 2.7 };
  const art = style === 'line'
    ? `<path d="${strokePath(arrowStrokes(a))}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="${polygonPath(arrowPolygon(a))}" fill="currentColor"/>`;
  return `<button type="button" data-arrow="${style}" title="${name}" aria-label="${name}" aria-pressed="${!i}"><svg viewBox="0 0 20 20" aria-hidden="true">${art}</svg></button>`;
}).join('');
arrowSet.addEventListener('click', event => {
  const chosen = (event.target as Element).closest<HTMLElement>('button');
  if (!chosen) return;
  const style = chosen.dataset.arrow as ArrowStyle;
  layer.style = { ...layer.style, arrow: style };
  layer.load(layer.annotations.map((item): Annotation => (item.kind === 'step' || item.kind === 'arrow') ? { ...item, style } : item));
  for (const button of all('button', arrowSet)) button.setAttribute('aria-pressed', String(button === chosen));
});
const lookSet = one('#looks');
lookSet.innerHTML = NOTE_STYLES.map(style => `<button type="button" data-look="${style}" aria-pressed="${style === FIRST_LOOK}"><span>${NOTE_STYLE_NAMES[style].split(' ')[0]}</span></button>`).join('');
lookSet.addEventListener('click', event => {
  const chosen = (event.target as Element).closest<HTMLElement>('button');
  if (!chosen) return;
  layer.noteStyle = chosen.dataset.look as NoteStyle;
  layer.render();
  for (const button of all('button', lookSet)) button.setAttribute('aria-pressed', String(button === chosen));
});
undo.addEventListener('click', () => { layer.undo(); listed = -1; syncSteps(); });
one('#wipe').addEventListener('click', () => { layer.load([]); listed = -1; syncSteps(); });

// ---- the recording plays, as the editor plays it: from the trimmed start, past the part cut out,
// moving in over the zoom, its marks coming and going when they were placed ----------------------
{
  const player = one('#player'), movie = one<HTMLVideoElement>('video', player), head = one('.player-strip i', player), zoomed = one('.player-zoom', player);
  const now = one('.player-times b', player), rest = one('.player-times span', player), button = one('.player-play', player);
  const SECONDS = 14.2, { kept: [first, final], cut: [cutFrom, cutTo], zoom: [zoomFrom, zoomTo] } = BOARD;
  const percent = (value: number, of: number) => `${(value / of * 100).toFixed(3)}%`;
  const place = (el: HTMLElement, { x, y, width, height }: { x: number; y: number; width: number; height: number }) => Object.assign(el.style, {
    left: percent(x, BOARD.window.width), top: percent(y, BOARD.window.height), width: percent(width, BOARD.window.width), height: percent(height, BOARD.window.height),
  });
  place(one('.player-clip', player), BOARD.capture); place(button, BOARD.play); place(one('.player-strip', player), BOARD.strip); place(one('.player-times', player), BOARD.times);

  const marks = new AnnotationLayer(one<SVGSVGElement>('.player-marks', player), document.createElement('div'), () => {});
  marks.setImage(2200, 1380);
  marks.notes = 'framed';
  const weight = marks.base * .8;
  const MARKS: Annotation[] = [
    { kind: 'step', id: 401, x: 1096, y: 1120, to: [1220, 704], note: 'Snaps back when dropped', style: 'mark', color: RED, weight, at: .4 * SECONDS },
    { kind: 'box', id: 402, x: 1024, y: 552, width: 440, height: 152, color: RED, weight, at: .55 * SECONDS, until: .64 * SECONDS },
  ];
  let seconds = .62 * SECONDS, shown = '';
  const showing = (item: Annotation) => showsAt(item, seconds);
  marks.showing = showing;
  const clock = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
  const lengthKept = (final - first - (cutTo - cutFrom)) * SECONDS;
  rest.textContent = `/ ${clock(lengthKept)} of ${clock(SECONDS)}`;
  const paint = () => {
    const share = seconds / SECONDS;
    head.style.left = `${(share * 100).toFixed(3)}%`;
    const played = seconds - first * SECONDS - (share >= cutTo ? (cutTo - cutFrom) * SECONDS : 0);
    now.textContent = clock(Math.max(0, played));
    // The zoom eases in and out over a little of the strip at each end of its band.
    const ease = (t: number) => t * t * (3 - 2 * t);
    const inward = ease(Math.min(1, Math.max(0, (share - zoomFrom) / .03))), outward = ease(Math.min(1, Math.max(0, (zoomTo - share) / .03)));
    zoomed.style.transform = `scale(${(1 + .5 * inward * outward).toFixed(4)})`;
    const on = MARKS.filter(showing).map(item => item.id).join();
    if (on !== shown) { shown = on; marks.load(MARKS); }
  };
  let wanted = !calm, inView = false, frameId = 0;
  const tick = () => {
    frameId = 0;
    if (movie.paused) return;
    seconds = movie.currentTime;
    const share = seconds / SECONDS;
    // A hair past each landing: a browser can round where it lands to just short of it, and would then
    // jump again every frame and never play on.
    if (share >= final || share < first) movie.currentTime = first * SECONDS + .01;
    else if (share >= cutFrom && share < cutTo) movie.currentTime = cutTo * SECONDS + .01;
    paint();
    frameId = requestAnimationFrame(tick);
  };
  // The host sends a whole file whatever part is asked for, and a browser that can't ask for part of a
  // video can't jump in it: Chrome stays on the first frame, because the trim and the cut both jump. Held
  // in memory the file can be jumped in anywhere. If fetching it fails, the video's own sources still try.
  let loading: Promise<void> | undefined;
  const load = () => loading ??= (async () => {
    const source = all<HTMLSourceElement>('source', movie).find(item => movie.canPlayType(item.type));
    if (!source) return;
    const response = await fetch(source.src);
    if (response.ok) movie.src = URL.createObjectURL(await response.blob());
  })().catch(() => {});
  const sync = () => {
    const go = wanted && inView;
    player.classList.toggle('playing', go);
    button.setAttribute('aria-label', wanted ? 'Pause' : 'Play');
    if (!go) { movie.pause(); return; }
    load().then(() => {
      if (wanted && inView) movie.play().then(() => { if (!frameId) frameId = requestAnimationFrame(tick); }).catch(() => {});
    });
  };
  movie.addEventListener('loadedmetadata', () => { movie.currentTime = seconds; }, { once: true });
  player.addEventListener('click', () => { wanted = !wanted; sync(); });
  new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; sync(); }, { threshold: .3 }).observe(player);
  document.fonts.ready.then(paint);
  paint();
}

// ---- the keyboard: every key that does something in Mark, from the app's own handlers ---------------
const USES: Record<string, [string, string][]> = {
  '4': [['⌘4', 'Capture']],
  A: [['A', 'Arrow, plain or numbered']],
  B: [['B', 'Box']],
  C: [['C', 'Crop'], ['⌘C', 'Copy'], ['⌥⌘C', 'Copy and close']],
  D: [['⌘D', 'Copy and paste in one go']],
  H: [['H', 'Highlighter']],
  I: [['I', 'Trim a recording’s start']],
  K: [['K', 'Cut a part out of a recording']],
  L: [['L', 'Line'], ['⇧⌘L', 'Copy the notes as a list']],
  M: [['M', 'Measure']],
  O: [['O', 'Ellipse, or trim a recording’s end']],
  P: [['P', 'Pen']],
  R: [['⇧⌘R', 'Hide what’s sensitive']],
  S: [['⌘S', 'Save'], ['⌥⌘S', 'Save a GIF']],
  T: [['T', 'Text'], ['⇧⌘T', 'Copy the words']],
  X: [['X', 'Redact']],
  Z: [['Z', 'Zoom in on clicks'], ['⌘Z', 'Undo']],
  '[': [['[', 'When a mark starts, on a recording']],
  ']': [[']', 'When a mark goes, on a recording']],
  space: [['Space', 'Take a whole window, or play a recording']],
  delete: [['⌫', 'Delete a mark']],
};
const ROWS: [string, number?, string?][][] = [
  [['`'], ['1'], ['2'], ['3'], ['4'], ['5'], ['6'], ['7'], ['8'], ['9'], ['0'], ['-'], ['='], ['delete', 1.7]],
  [['tab', 1.5], ['Q'], ['W'], ['E'], ['R'], ['T'], ['Y'], ['U'], ['I'], ['O'], ['P'], ['['], [']'], ['\\', 1.2]],
  [['caps', 1.8], ['A'], ['S'], ['D'], ['F'], ['G'], ['H'], ['J'], ['K'], ['L'], [';'], ['’'], ['return', 1.9]],
  [['shift', 2.35, 'mod'], ['Z'], ['X'], ['C'], ['V'], ['B'], ['N'], ['M'], [','], ['.'], ['/'], ['shift', 2.35, 'mod']],
  [['fn'], ['control', 1.1], ['option', 1.1, 'mod'], ['command', 1.4, 'mod'], ['space', 5.6], ['command', 1.4, 'mod'], ['option', 1.1, 'mod'], ['←'], ['↑'], ['→']],
];
const keyboard = one('#keyboard'), reader = one('#reader');
keyboard.innerHTML = ROWS.map(row => `<div class="keyrow">${row.map(([label, u = 1, kind]) => {
  const cls = `key${USES[label] ? ' has' : ''}${kind ? ` ${kind}` : ''}`;
  return `<div class="${cls}" style="--u:${u}" data-key="${label}">${label === 'space' ? '' : label}</div>`;
}).join('')}</div>`).join('');
const keyEls = all('.key');
const chordKeys = (chord: string) => (chord === 'Space' ? ['space'] : chord === '⌫' ? ['delete'] : [...chord])
  .map(ch => ({ '⌘': 'command', '⌥': 'option', '⇧': 'shift' })[ch] ?? ch);
const light = (names: string[]) => { for (const el of keyEls) el.classList.toggle('on', names.includes(el.dataset.key!)); };
const read = (key: string) => {
  const uses = USES[key];
  if (!uses) return;
  light(chordKeys(uses[uses.length - 1][0]).concat(key));
  reader.innerHTML = `<ul>${uses.map(([chord, what]) => `<li><span>${chord}</span>${what}</li>`).join('')}</ul>`;
};
read('4');
keyboard.addEventListener('pointerover', event => { const key = (event.target as Element).closest<HTMLElement>('.key.has'); if (key) read(key.dataset.key!); });
keyboard.addEventListener('pointerleave', () => read('4'));
// Pressed for real, while the keyboard's in view, unless you're typing somewhere.
let keysSeen = false;
new IntersectionObserver(([entry]) => { keysSeen = entry.isIntersecting; }, { threshold: .5 }).observe(keyboard);
addEventListener('keydown', event => {
  const target = event.target as HTMLElement;
  if (!keysSeen || /^(INPUT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable) return;
  const code = event.code;
  const key = code.startsWith('Key') ? code.slice(3) : code.startsWith('Digit') ? code.slice(5)
    : ({ Space: 'space', Backspace: 'delete', BracketLeft: '[', BracketRight: ']' } as Record<string, string>)[code];
  if (!key || !USES[key]) return;
  if (key === 'space') event.preventDefault();
  read(key);
});
one('#keylist').innerHTML = Object.values(USES).flat().filter(([chord]) => /[⌘⇧⌥]|Space|^[KZ]$/.test(chord)).map(([chord, what]) => `<li><span>${what}</span><kbd class="k">${chord}</kbd></li>`).join('');

// ---- fine line drawings, from the real geometry -----------------------------------------------------
{
  const a: Arrow = { kind: 'arrow', id: 1, style: 'mark', x1: 44, y1: 176, x2: 262, y2: 44, color: '', weight: 22 };
  one('#fig-arrow').innerHTML = `
    <path class="wire dot" d="M16 193 292 26"/>
    <path class="wire dot" d="M262 12v190M16 44h292"/>
    ${[0, 1, 2].map(i => `<path class="wire${i ? ' dot' : ''}" d="${polygonPath(arrowPolygon({ ...a, x1: a.x1 + i * 3, y1: a.y1 + i * 11 }))}"/>`).join('')}
    <circle class="wire red" cx="262" cy="44" r="6"/>
    <path class="wire red" d="M262 30v8M262 50v8M248 44h8M268 44h8"/>
    <text x="274" y="64" fill="#8b9098" font-family="ui-monospace, SF Mono, Menlo, monospace" font-size="9.5">tip</text>`;
  const cells: string[] = [];
  const shades = [.09, .16, .23, .12, .3, .19, .26, .14, .21, .1, .28, .17, .24, .13, .33, .2, .11, .27, .15, .22, .18, .31, .12, .25];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 8; col++) {
    cells.push(`<rect x="${40 + col * 30}" y="${60 + row * 30}" width="30" height="30" fill="#fff" fill-opacity="${shades[row * 8 + col]}"/>`);
  }
  one('#fig-redact').innerHTML = `
    <path class="wire dot" d="M16 60h288M16 150h288M40 30v150M280 30v150"/>
    <g>${cells.join('')}</g>
    ${Array.from({ length: 9 }, (_, i) => `<path class="wire" d="M${40 + i * 30} 60v90"/>`).join('')}
    ${Array.from({ length: 4 }, (_, i) => `<path class="wire" d="M40 ${60 + i * 30}h240"/>`).join('')}
    <text x="40" y="44" fill="#8b9098" font-family="ui-monospace, SF Mono, Menlo, monospace" font-size="9.5">30 × 30 px, averaged</text>`;
  // A closed box, drawn on an isometric grid, with the one way out marked.
  const iso = (x: number, y: number, z: number) => [160 + (x - y) * .866, 128 + (x + y) * .5 - z];
  const line = (points: [number, number, number][]) => points.map((p, i) => `${i ? 'L' : 'M'}${iso(...p).map(n => n.toFixed(1)).join(' ')}`).join('');
  const s = 72, h = 44;
  const plates = [0, 1, 2, 3].map(i => `<path class="wire${i === 3 ? '' : ' dot'}" d="${line([[-s, -s, h * i / 3], [s, -s, h * i / 3], [s, s, h * i / 3], [-s, s, h * i / 3]])}Z"/>`).join('');
  const out: Arrow = { kind: 'arrow', id: 2, style: 'mark', x1: 172, y1: 118, x2: 300, y2: 178, color: '', weight: 5.5 };
  one('#fig-mac').innerHTML = `${plates}
    <path class="wire" d="${line([[s, s, 0], [s, s, h]])}M${iso(-s, s, 0).join(' ')}L${iso(-s, s, h).join(' ')}M${iso(s, -s, 0).join(' ')}L${iso(s, -s, h).join(' ')}"/>
    <path class="wire dot" d="${line([[-s, -s, 0], [-s, -s, h]])}"/>
    <path d="${polygonPath(arrowPolygon(out))}" fill="${RED}"/>
    <text x="276" y="198" fill="#8b9098" font-family="ui-monospace, SF Mono, Menlo, monospace" font-size="9.5">Send</text>`;
}

// ---- the changelog, from the release notes themselves ---------------------------------------------------
const NOTES = import.meta.glob<string>('/release-notes/*.md', { query: '?raw', import: 'default', eager: true });
const versions = Object.entries(NOTES).flatMap(([path, text]) => {
  const version = path.match(/([\d.]+)\.md$/)?.[1], first = text.match(/^- \*\*(.+?)\*\*\s*(.+)$/m);
  return version && first ? [{ version, order: version.split('.').map(Number), title: first[1].replace(/\.$/, ''), text: first[2].trim() }] : [];
}).sort((a, b) => b.order[0] - a.order[0] || b.order[1] - a.order[1] || b.order[2] - a.order[2]).slice(0, 4);
one('#changelog').innerHTML = versions.map(({ version, title, text }) => `<li><h3>${title}</h3><p>${text}</p><time>${version}</time></li>`).join('');

// ---- what moves -------------------------------------------------------------------------------------
startMotion({ layer, start: START, capture: { scrolling, choose, setRect, readSize, shutter }, arrows: drawPageArrows() });
