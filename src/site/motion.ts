/** The landing page's motion layer: what scrolls at its own speed, what's scrubbed by the scroll,
 *  and what plays once on the way in. No library: one loop, smoothing the scroll, drives it all.
 *  site.html's head turns it on with html.motion, before the first paint; without that class
 *  (?motion=off, or a visitor who asks for less motion) none of this runs. */
import { AnnotationLayer, type Annotation, type Point, type Step } from '../annotations';
import type { PageArrows } from './arrows';
import { all, one } from './facts';

declare global {
  interface Window { __motionStarted?: boolean }
}

/** Step 1's picture of capturing, which the scroll drives once it can. */
export interface CaptureStage {
  scrolling: { jump: ((index: number) => void) | null };
  choose(mode: string, play?: boolean): Promise<void>;
  setRect(x: number, y: number, width: number, height: number): void;
  readSize(): void;
  shutter(): void;
}
interface Parts { layer: AnnotationLayer; start: readonly Step[]; capture: CaptureStage; arrows: PageArrows }

const clamp = (v: number, low = 0, high = 1) => Math.min(high, Math.max(low, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
/** How far v has come through the span from a to b, 0 to 1. */
const through = (v: number, a: number, b: number) => clamp((v - a) / (b - a));
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** A numbered mark partway through being made: a press for the number, a drag for the arrow, then the words. */
const markAt = (mark: Step, t: number, growing: [number, number], typing: [number, number]): Step | null => {
  if (t <= 0) return null;
  const grow = easeOut(through(t, ...growing)), typed = through(t, ...typing), [x, y] = mark.to!;
  const to: Point | undefined = grow > .03 ? [mix(mark.x, x, grow), mix(mark.y, y, grow)] : undefined;
  return { ...mark, to, note: (mark.note ?? '').slice(0, Math.round((mark.note ?? '').length * typed)) };
};
const made = (marks: readonly (Step | null)[]) => marks.filter((mark): mark is Step => mark !== null) as Annotation[];

export function startMotion({ layer: drawLayer, start, capture, arrows }: Parts): void {
  const root = document.documentElement;
  if (!root.classList.contains('motion')) return;
  window.__motionStarted = true;

  // ---- the loop ----------------------------------------------------------------------
  const scrubs: ((y: number) => void)[] = [], layouts: (() => void)[] = [];
  let vh = innerHeight, smooth = scrollY, frame = 0;
  const request = () => { if (!frame) frame = requestAnimationFrame(tick); };
  function tick() {
    frame = 0;
    smooth += (scrollY - smooth) * .14;
    if (Math.abs(scrollY - smooth) < .25) smooth = scrollY;
    for (const scrub of scrubs) scrub(smooth);
    if (smooth !== scrollY) request();
  }
  // Where things sit in the page, ignoring the transforms put on them. Read once per layout.
  const pageTop = (el: HTMLElement) => {
    let top = 0;
    for (let at: HTMLElement | null = el; at; at = at.offsetParent as HTMLElement | null) top += at.offsetTop;
    return top;
  };
  function layout() {
    vh = innerHeight;
    for (const measure of layouts) measure();
    for (const scrub of scrubs) scrub(smooth);
  }
  addEventListener('scroll', request, { passive: true });
  addEventListener('resize', layout);
  addEventListener('load', layout);
  new ResizeObserver(() => layout()).observe(document.body);

  /** Moves at its own speed: above 0 it lags the page, below 0 it hurries. */
  function depth(el: HTMLElement, speed: number, extra: (away: number) => string = () => '') {
    let top = 0, height = 0;
    el.dataset.depth = String(speed);
    layouts.push(() => { top = pageTop(el); height = el.offsetHeight; });
    scrubs.push(y => {
      const away = clamp(top + height / 2 - (y + vh / 2), -vh * 1.3, vh * 1.3);
      el.style.transform = `translate3d(0, ${(away * speed).toFixed(1)}px, 0) ${extra(away)}`;
    });
  }
  /** Lies back in perspective, and stands up as it comes up the screen. */
  function standUp(el: HTMLElement, degrees: number, { from = 1, to = .42, scale = .95 } = {}) {
    let top = 0;
    el.classList.add('tilt');
    layouts.push(() => { top = pageTop(el); });
    scrubs.push(y => {
      const t = easeOut(through(y, top - vh * from, top - vh * to));
      el.style.transform = t >= 1 ? 'none'
        : `perspective(1800px) translateY(${((1 - t) * 40).toFixed(1)}px) rotateX(${((1 - t) * degrees).toFixed(2)}deg) scale(${mix(scale, 1, t).toFixed(4)})`;
    });
  }

  // ---- things that play once, on the way in ------------------------------------------------
  const seen = new IntersectionObserver(entries => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting) continue;
      target.classList.add('seen');
      target.dispatchEvent(new CustomEvent('seen'));
      seen.unobserve(target);
    }
  }, { threshold: .2, rootMargin: '0px 0px -8% 0px' });
  /** Each word in a span of its own, so a heading can rise a word at a time. */
  function words(el: Element) {
    let i = 0;
    const wrap = (pop = false) => {
      const word = document.createElement('span');
      word.className = pop ? 'w pop' : 'w';
      word.style.setProperty('--i', String(i++));
      return word;
    };
    for (const node of [...el.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) {
        const holder = document.createDocumentFragment();
        for (const part of (node.textContent ?? '').split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) { holder.append(part); continue; }
          const word = wrap(); word.textContent = part; holder.append(word);
        }
        node.replaceWith(holder);
      } else if (node.nodeName !== 'BR') {
        const word = wrap((node as Element).classList?.contains('n'));
        node.replaceWith(word); word.append(node);
      }
    }
  }
  for (const heading of all('main h1, main h2')) {
    words(heading);
    seen.observe(heading);
  }
  // A window opened far taller than any screen, as a search engine's does, reads everything at once.
  addEventListener('resize', () => {
    if (innerHeight >= 2000) for (const el of all('main h1, main h2, .rv, .palette, .keyboard, .figs article, .log')) el.classList.add('seen');
  });
  const reveal = (selector: string, gap = 1) => all(selector).forEach((el, i) => {
    el.classList.add('rv'); el.style.setProperty('--i', String(i * gap)); seen.observe(el);
  });
  for (const selector of ['.chapter .head .lede', '.chapter .head .row-actions', '.ask .lede', '.ask .row-actions', '.setup > div', '.facts > div', '.chord', '.last .get', '.last .fine', '.devices figcaption']) reveal(selector);

  // ---- the hero ----------------------------------------------------------------------------
  {
    const hero = one('.hero'), frameEl = one('.demo-frame'), shotEl = one('.hero-shot');
    for (const selector of ['.hero .lede', '.hero-cta .get', '.hero .fine', '.hero .works', '.hero .hero-shot']) reveal(selector);
    // Each line leaves at its own speed, the demo sliding up over them as it stands.
    const parts = ([['h1', .36], ['.lede', .28], ['.hero-cta', .22], ['.fine', .17], ['.works', .13]] as const).map(([selector, speed]) => [one(`.hero ${selector}`), speed] as const);
    // Once risen, they follow the scroll directly: the rise's ease would make them trail behind it.
    setTimeout(() => all('.hero .rv').forEach(el => el.classList.add('settled')), 1700);
    let top = 0;
    // A hidden frame has no place in the page, and the words would fade by a distance of nothing:
    // a phone or a tablet goes by its picture.
    layouts.push(() => { top = pageTop(frameEl.offsetParent ? frameEl : shotEl); });
    scrubs.push(y => {
      hero.style.setProperty('--glow', `${(y * .3).toFixed(1)}px`);
      for (const [el, speed] of parts) {
        el.style.transform = y > 1 ? `translate3d(0, ${(y * speed).toFixed(1)}px, 0)` : '';
        el.style.opacity = y > 1 ? (1 - through(y, 60, top * .78)).toFixed(3) : '';
      }
      const t = easeOut(through(y, 0, top - vh * .14));
      frameEl.style.transform = t >= 1 ? 'none'
        : `perspective(1800px) translateY(${((1 - t) * 44).toFixed(1)}px) rotateX(${((1 - t) * 24).toFixed(2)}deg) scale(${mix(.93, 1, t).toFixed(4)})`;
    });
  }

  // ---- colour floating behind the page, each patch at its own speed -----------------------------------
  // Not on a phone, where the colour just sits: each patch moving would be a layer to hold in memory.
  if (root.clientWidth >= 721) all('.ambient i').forEach((blob, i) => depth(blob, [-.14, -.22, -.09][i % 3]));

  // ---- how it works: the paragraph crossed out as the marks replace it ------------------------------
  const pin = matchMedia('(min-width: 1041px) and (min-height: 620px)');
  pin.addEventListener('change', () => location.reload());
  if (pin.matches) {
    root.classList.add('pin');
    const track = one('.how-track'), stage = one('.how-stage'), versus = one('.versus');
    const [typedFigure, sendFigure] = all('.versus figure');
    const shot = one('.shot', sendFigure), image = one<HTMLImageElement>('img', shot), typed = one('#typed'), wordCount = one('#typed-count');
    const marksCount = one('figcaption span', sendFigure);
    marksCount.id = 'marks-count';
    image.src = './site/checkout-clean.webp';
    const foot = Object.assign(new Image(), { src: './site/checkout.webp', alt: '', className: 'how-foot' });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'how-marks');
    const holder = document.createElement('div');
    holder.hidden = true;
    shot.append(foot, svg, holder);

    // The same marks as the picture they replace, at the same size, as a person makes them.
    const layer = new AnnotationLayer(svg, holder, () => {});
    layer.setImage(2200, 1280);
    layer.notes = 'framed';
    const weight = layer.base * .65, RED = '#ff3b30';
    const MARKS: Step[] = [
      { x: 600, y: 932, to: [500, 1006], note: 'Show the date, not the days' },
      { x: 580, y: 1112, to: [1184, 1112], note: 'Make Express free over $75' },
      { x: 1280, y: 1224, to: [1786, 1132], note: 'Make Pay now full width' },
    ].map((mark, i) => ({ kind: 'step', id: i + 201, style: 'mark', color: RED, weight, ...mark, to: mark.to as Point }));

    const SENTENCES = [
      'Can you fix a few things on the checkout?',
      'Where it says how many business days for Standard, show the actual date instead.',
      'Express should be free over $75, that’s the $12 one.',
      'And the green button, no, the one under the total, should go the full width.',
    ];
    typed.innerHTML = SENTENCES.map(text => `<span class="say">${text}</span>`).join(' ');
    const says = all('.say', typed), counts = SENTENCES.map(text => text.split(/\s+/).length);

    const head = one('.head', stage), BAR = 84;
    let top = 0, length = 1, dx = 0, dy = 0, grown = 1, drawn = '';
    layouts.push(() => {
      versus.style.removeProperty('--fit');
      // It pins with its top under the bar, and lets go when its bottom meets the track's.
      top = pageTop(track) - BAR; length = track.offsetHeight - stage.offsetHeight;
      // All of it has to fit the window while it's pinned, so a short window gets a narrower pair.
      const room = vh - BAR - head.offsetHeight - 70, share = sendFigure.offsetWidth / Math.max(1, versus.offsetWidth);
      const pictureRatio = sendFigure.offsetWidth / Math.max(1, sendFigure.offsetHeight);
      versus.style.setProperty('--fit', `${Math.round(Math.min(versus.offsetWidth, room * pictureRatio / share))}px`);
      // Where the picture ends up once it's all that's needed: in the middle, as large as fits.
      const offset = sendFigure.offsetLeft - versus.offsetLeft;
      dx = (versus.offsetWidth - sendFigure.offsetWidth) / 2 - offset;
      grown = Math.min(1.42, (vh - BAR - 44) / Math.max(1, sendFigure.offsetHeight), versus.parentElement!.clientWidth / Math.max(1, sendFigure.offsetWidth));
      dy = 24 - versus.offsetTop;
    });
    scrubs.push(y => {
      const p = through(y, top, top + length);
      const windows = MARKS.map((_, i) => through(p, .07 + .235 * i, .07 + .235 * (i + 1) - .015));

      // The marks, redrawn only when they've changed: the real geometry, a frame at a time.
      const key = windows.map(t => t.toFixed(3)).join();
      if (key !== drawn) {
        drawn = key;
        layer.load(made(MARKS.map((mark, i) => markAt(mark, windows[i], [.1, .55], [.58, .97]))));
      }

      // The opening line goes first; then each sentence lights while its mark is made, and is crossed out.
      const intro = through(p, .015, .07);
      says[0].style.setProperty('--s', intro.toFixed(3));
      says[0].classList.toggle('on', p < .07);
      says[0].classList.toggle('done', p >= .07);
      windows.forEach((t, i) => {
        const say = says[i + 1];
        say.style.setProperty('--s', through(t, .72, 1).toFixed(3));
        say.classList.toggle('on', t > 0 && t < 1);
        say.classList.toggle('done', t >= 1);
      });
      const left = counts.reduce((sum, count, i) => sum + ((i === 0 ? intro : windows[i - 1]) >= 1 ? 0 : count), 0);
      wordCount.textContent = `${left} word${left === 1 ? '' : 's'}`;
      const finished = windows.filter(t => t >= .9).length;
      marksCount.textContent = `${finished} mark${finished === 1 ? '' : 's'}`;
      foot.style.opacity = through(p, .72, .77).toFixed(3);

      // And then the paragraph isn't needed: it leaves, and the picture takes the room.
      const end = easeInOut(through(p, .8, .97));
      // Held in its own layer only while it moves, so it's redrawn sharp at its final size.
      for (const figure of [typedFigure, sendFigure]) figure.style.willChange = end > 0 && end < 1 ? 'transform' : 'auto';
      typedFigure.style.transform = `translate3d(${(-48 * end).toFixed(1)}px, 0, 0)`;
      typedFigure.style.opacity = (1 - end).toFixed(3);
      sendFigure.style.transform = `translate3d(${(dx * end).toFixed(1)}px, ${(dy * end).toFixed(1)}px, 0) scale(${mix(1, grown, end).toFixed(4)})`;
      head.style.opacity = (1 - through(p, .8, .9)).toFixed(3);
      head.style.transform = `translate3d(0, ${(-30 * end).toFixed(1)}px, 0)`;
    });
  }

  // ---- 1: capture: scrolling steps through each way to capture, and plays it -----------------------------
  {
    const modes = all('.modes .mode'), palette = one('.palette'), grab = one('.stage-grab');
    modes.forEach((mode, i) => { mode.classList.add('rv'); mode.style.setProperty('--i', String(i)); });
    seen.observe(palette);
    if (pin.matches && vh >= 700) {
      root.classList.add('pin-capture');
      const BAR = 84, ORDER = ['region', 'window', 'display', 'timed', 'record'];
      const track = one('.capture-track'), stage = one('.capture-stage'), demo = one('.capture-demo'), head = one('.head', stage);
      const count = one('#count'), reading = one('#reading'), recordButton = one('.recbar b');
      let top = 0, length = 1, current = -1, was = 0, morphing = 0;
      layouts.push(() => {
        demo.style.removeProperty('--fit');
        top = pageTop(track) - BAR; length = track.offsetHeight - stage.offsetHeight;
        // All of it has to fit the window while it's pinned.
        const room = vh - BAR - head.offsetHeight - 46;
        if (demo.offsetHeight > room) demo.style.setProperty('--fit', `${Math.round(demo.offsetWidth * room / demo.offsetHeight)}px`);
      });
      capture.scrolling.jump = i => scrollTo({ top: top + length * (i + .55) / ORDER.length });
      // Between ways the selection eases from one shape to the next, its size reading along.
      const morph = () => {
        grab.classList.add('morph');
        cancelAnimationFrame(morphing);
        const started = performance.now();
        const follow = (now: number) => {
          capture.readSize();
          if (now - started < 480) morphing = requestAnimationFrame(follow);
          else grab.classList.remove('morph');
        };
        morphing = requestAnimationFrame(follow);
      };
      const clock = (seconds: number) => `0:${String(Math.floor(seconds)).padStart(2, '0')}`;
      scrubs.push(y => {
        const position = through(y, top, top + length) * .9999 * ORDER.length;
        const at = Math.floor(position), t = position - at;
        if (at !== current) {
          const first = current === -1;
          current = at; was = t;
          void capture.choose(ORDER[at], false);
          grab.classList.remove('rolling');
          recordButton.textContent = 'Record';
          if (!first) morph();
          modes.forEach((mode, i) => mode.style.setProperty('--t', i < at ? '1' : '0'));
        }
        modes[at].style.setProperty('--t', t.toFixed(3));
        const crossed = (mark: number) => was < mark && t >= mark;   // only going forward
        if (ORDER[at] === 'region') {
          // The drag itself, scrubbed: tight at first, then out to the region.
          const grow = easeOut(through(t, .04, .72)), box = grab.getBoundingClientRect();
          capture.setRect(.4 * box.width, .24 * box.height, .42 * box.width * grow + 2, .5 * box.height * grow + 2);
          if (crossed(.78)) capture.shutter();
        } else if (ORDER[at] === 'window') {
          if (crossed(.6)) capture.shutter();
        } else if (ORDER[at] === 'display') {
          if (crossed(.45)) capture.shutter();
        } else if (ORDER[at] === 'timed') {
          // Five seconds, counted down over the shot, then the shutter.
          const left = 5 - Math.floor(through(t, .03, .88) * 5);
          count.textContent = t < .88 ? String(Math.max(1, left)) : '';
          if (crossed(.88)) capture.shutter();
        } else {
          // Press Record, and the frame goes red and the time runs.
          const rolling = t > .3;
          grab.classList.toggle('rolling', rolling);
          recordButton.textContent = rolling ? 'Stop' : 'Record';
          if (rolling) reading.textContent = clock(through(t, .3, 1) * 14);
          else capture.readSize();
        }
        was = t;
      });
    } else {
      depth(palette, -.05);
      depth(grab, .035);
    }
  }

  // ---- 2: mark it up: the marks made in front of you, once ------------------------------------------------
  {
    const draw = one('.draw'), overlay = one('#overlay'), steps = one('#steps');
    standUp(draw, 13, { from: .95, to: .5, scale: .96 });
    let playing = false, done = false;
    const field = (mark: Step) => steps.querySelector<HTMLTextAreaElement>(`[data-id="${mark.id}"]`);
    const finish = () => {
      if (done) return;
      done = true; playing = false;
      drawLayer.load(start);
      for (const mark of start) { const box = field(mark); if (box) box.value = mark.note ?? ''; }
    };
    document.fonts.ready.then(() => { if (!done) drawLayer.load([]); });
    draw.addEventListener('seen', () => {
      if (done) return;
      playing = true;
      const started = performance.now(), each = 1050;
      const play = (now: number) => {
        if (!playing) return;
        const at = (now - started) / each;
        drawLayer.load(made(start.map((mark, i) => markAt(mark, clamp(at - i * .92), [.08, .5], [.5, 1]))));
        start.forEach((mark, i) => {
          const box = field(mark), note = mark.note ?? '';
          if (box) box.value = note.slice(0, Math.round(note.length * through(clamp(at - i * .92), .5, 1)));
        });
        if (at < start.length * .92 + .1) requestAnimationFrame(play); else finish();
      };
      requestAnimationFrame(play);
    });
    seen.observe(draw);
    // Reaching for the picture, or its tools, ends the show.
    for (const el of [overlay, one('.tools')]) el.addEventListener('pointerdown', finish, { capture: true });
  }

  // ---- 3: send it: the keys, then what they did ---------------------------------------------------------------
  {
    const section = one('.send'), copied = one('.copied'), [first, second] = all('.chord .keys');
    const pre = one('.term pre');
    pre.innerHTML = [
      '<span class="dim">›</span> <span class="tag">[Image #1]</span>',
      '<span class="me">  1. Add an “All time” range</span>',
      '<span class="me">  2. Show the day’s total on hover</span>',
      '<span class="me">  3. Label the dashed line “Last year”</span>',
      '',
      '<span class="dim">›</span> <span class="caret"></span>',
    ].map(line => `<span class="line">${line}</span>`).join('');
    const lines = all('.line', pre);
    let top = 0;
    layouts.push(() => { top = pageTop(section); });
    const press = (keys: HTMLElement, down: boolean) => all('.kc', keys).forEach(key => key.classList.toggle('down', down));
    scrubs.push(y => {
      const p = through(y, top - vh * .86, top - vh * .24);
      press(first, p > .16 && p < .26);
      press(second, p > .5 && p < .6);
      const fly = easeOut(through(p, .22, .46));
      copied.style.opacity = fly.toFixed(3);
      // Off the far corner and into place, where the arrow leaves from.
      copied.style.transform = `translate3d(${((1 - fly) * 150).toFixed(1)}px, ${((1 - fly) * -110).toFixed(1)}px, 0) rotate(${mix(9, 1.6, fly).toFixed(2)}deg) scale(${mix(1.14, 1, fly).toFixed(3)})`;
      arrows.pasted.set(easeOut(through(p, .46, .58)));
      lines[0].classList.toggle('on', p > .42);
      lines[1].classList.toggle('on', p > .58);
      lines[2].classList.toggle('on', p > .65);
      lines[3].classList.toggle('on', p > .72);
      lines[4].classList.toggle('on', p > .76);
      lines[5].classList.toggle('on', p > .76);
    });
  }

  // ---- the agent asks: the picture leans in from the side ---------------------------------------------------------
  {
    const shot = one('.ask .shot'), image = one('img', shot);
    shot.classList.add('deep');
    let top = 0;
    layouts.push(() => { top = pageTop(shot); });
    scrubs.push(y => {
      const t = easeOut(through(y, top - vh * .98, top - vh * .34));
      shot.style.transform = t >= 1 ? 'none' : `perspective(1600px) translate3d(${((1 - t) * -46).toFixed(1)}px, ${((1 - t) * 34).toFixed(1)}px, 0) rotateY(${((1 - t) * 16).toFixed(2)}deg)`;
      image.style.transform = `scale(${mix(1.08, 1, t).toFixed(4)})`;
    });
  }

  // ---- video: its window stands up; the recording in it plays by itself -----------------------------------
  standUp(one('#video .shot'), 11, { from: .98, to: .55, scale: .97 });

  // ---- devices: each at its own speed -----------------------------------------------------------------------------------
  all('.devices figure').forEach((figure, i) => {
    // Gentler on a phone, where the pictures sit closer together.
    const gentle = root.clientWidth < 721 ? .35 : 1, speed = [.1, -.07, .05, -.11][i] * gentle, turn = [-1.2, .8, -.6, 1.1][i] * gentle;
    depth(figure, speed, away => `rotate(${(away / vh * turn).toFixed(3)}deg)`);
  });

  // ---- the keyboard: it stands up, and a ripple spreads from ⌘4 --------------------------------------------------------
  {
    const keyboard = one('.keyboard');
    standUp(keyboard, 26, { from: .98, to: .5, scale: .94 });
    const keys = all('.key', keyboard), four = keys.find(key => key.dataset.key === '4')!;
    const centre = (el: HTMLElement) => { const box = el.getBoundingClientRect(); return [box.left + box.width / 2, box.top + box.height / 2]; };
    const [cx, cy] = centre(four);
    for (const key of keys) {
      const [x, y] = centre(key);
      key.style.setProperty('--d', (Math.hypot(x - cx, (y - cy) * 1.3) / Math.max(1, four.offsetWidth)).toFixed(2));
    }
    seen.observe(keyboard);
  }

  // ---- line drawings, and the changelog ------------------------------------------------------------------------------------
  for (const article of all('.figs article')) {
    for (const path of all<SVGElement>('.wire:not(.dot)', article)) path.setAttribute('pathLength', '1');
    seen.observe(article);
  }
  const log = one('.log');
  all('li', log).forEach((item, i) => item.style.setProperty('--i', String(i)));
  seen.observe(log);

  // ---- the last arrow rises to the button, its echoes and its light coming after --------------------------------------------
  {
    const section = one('.last'), layers = all<SVGSVGElement>('.giant.up svg'), button = one('.last .get');
    const lags = [1.0, 1.12, 1.3];
    let top = 0, landed = false;
    layouts.push(() => { top = pageTop(section); });
    scrubs.push(y => {
      const p = through(y, top - vh * .9, Math.min(top - vh * .05, root.scrollHeight - vh - 2));
      layers.forEach((layer, i) => {
        const rest = 1 - easeOut(clamp(p * lags[lags.length - 1 - i]));
        // Along the arrow's own length: in its drawing, back is up and to the right.
        layer.style.transform = `translate3d(${(rest * 38).toFixed(2)}%, ${(rest * -30).toFixed(2)}%, 0)`;
        if (i === 0) layer.style.opacity = (1 - rest).toFixed(3);
      });
      if (p >= .995 && !landed) { landed = true; button.classList.add('landed'); }
      if (p < .9) { landed = false; button.classList.remove('landed'); }
    });
  }

  // ---- Mark's arrows, drawn as a drag draws them: out from the tail to the tip ---------------------------
  {
    const draw = (arrow: { set(t: number): void }, delay: number, long = 820) => setTimeout(() => {
      const started = performance.now();
      const step = (now: number) => {
        const t = clamp((now - started) / long);
        arrow.set(easeOut(t));
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }, delay);
    // Once the hero's words have risen, it points at the button.
    draw(arrows.hero, 1050);
    // When Step 1's heading has come up, at the keys.
    const keys = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      keys.disconnect();
      draw(arrows.keys, 650);
    }, { threshold: .6 });
    keys.observe(one('[aria-labelledby="ch-capture"] .lede'));
    // This one follows the scroll, once what it points from has arrived.
    const send = one('.ask .shot');
    let sendTop = 0;
    layouts.push(() => { sendTop = pageTop(send); });
    scrubs.push(y => arrows.send.set(easeOut(through(y, sendTop - vh * .62, sendTop - vh * .34))));
  }

  layout();
  root.classList.add('ready');
  document.fonts.ready.then(layout);
  // The first paint first, then the hero's words rise.
  requestAnimationFrame(() => request());
}
