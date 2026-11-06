/** Mark's real arrows on the page itself, each pointing at something to do: drawn by the app's
 *  own layer, in its Soft solid style. Without the motion layer they simply sit where they point;
 *  with it, motion.ts draws them out, as a drag would, by moving the tip from the tail. */
import { AnnotationLayer, type Point } from '../annotations';
import { one } from './facts';

const RED = '#ff3b30';
const root = document.documentElement;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }
type Ends = (box: (el: HTMLElement) => Box, host: HTMLElement) => [Point, Point] | null;

/** Where an element sits inside another, ignoring any transforms put on them while they move. */
function within(el: HTMLElement, host: HTMLElement): Box {
  const offset = (node: HTMLElement): Point => {
    let x = 0, y = 0;
    for (let at: HTMLElement | null = node; at; at = at.offsetParent as HTMLElement | null) { x += at.offsetLeft; y += at.offsetTop; }
    return [x, y];
  };
  const [ex, ey] = offset(el), [hx, hy] = offset(host);
  return { left: ex - hx, top: ey - hy, right: ex - hx + el.offsetWidth, bottom: ey - hy + el.offsetHeight, width: el.offsetWidth, height: el.offsetHeight };
}

export interface PageArrow {
  layout(): void;
  /** How far it's been drawn, 0 to 1. */
  set(shown: number): void;
}

let nextId = 501;   // Paints are found by id across the whole page, so these keep to their own.
function pageArrow({ host, className, weight, minWidth = 0, ends }: { host: string; className: string; weight: number; minWidth?: number; ends: Ends }): PageArrow {
  const hostEl = one(host), svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `page-arrow ${className}`);
  svg.setAttribute('aria-hidden', 'true');
  hostEl.append(svg);
  const layer = new AnnotationLayer(svg, document.createElement('div'), () => {});
  layer.notes = 'framed';
  layer.noteStyle = 'solid';
  const id = nextId++;
  let from: Point | null = null, to: Point | null = null, shown = root.classList.contains('motion') ? 0 : 1, drawn = -1;
  const paint = () => {
    const key = from ? Math.round(shown * 500) : -1;
    if (key === drawn) return;
    drawn = key;
    // Too short to be an arrow yet, it would only be a head: it starts once it has some length.
    if (!from || !to || shown < .1) { layer.load([]); return; }
    layer.load([{ kind: 'arrow', id, style: 'mark', color: RED, weight, x1: from[0], y1: from[1], x2: mix(from[0], to[0], shown), y2: mix(from[1], to[1], shown) }]);
  };
  return {
    layout() {
      layer.resize(hostEl.offsetWidth, hostEl.offsetHeight);
      const points = root.clientWidth >= minWidth ? ends(el => within(el, hostEl), hostEl) : null;
      [from, to] = points ?? [null, null];
      drawn = -2;
      paint();
    },
    set(t) { shown = t; paint(); },
  };
}

export type PageArrows = ReturnType<typeof drawPageArrows>;

export function drawPageArrows() {
  const arrows = {
    // At the hero's button, in from the right.
    hero: pageArrow({
      host: '.hero-cta', className: 'hero-arrow', weight: 24, minWidth: 721,
      ends(box, host) {
        const button = box(one('.hero-cta .get'));
        return [[Math.min(button.right + 232, host.offsetWidth - 8), button.top - 33], [button.right - 7, button.top + 6]];
      },
    }),
    // Step 1: from "Press the keys" to the keys.
    keys: pageArrow({
      host: '[aria-labelledby="ch-capture"] .head', className: 'keys-arrow', weight: 17, minWidth: 1041,
      ends(box) {
        const keys = one('#ch-capture').querySelectorAll<HTMLElement>('.kc'), words = box(one('[aria-labelledby="ch-capture"] .lede'));
        const key = box(keys[keys.length - 1]);
        return [[words.left - 12, words.top + words.height * .52], [key.right + 12, key.top + key.height * .55]];
      },
    }),
    // Step 3: the picture, to where it was pasted.
    pasted: pageArrow({
      host: '.term-wrap', className: 'pasted-arrow', weight: 15, minWidth: 1041,
      ends(box) {
        const tag = document.querySelector<HTMLElement>('.term .tag');
        if (!tag) return null;
        const picture = box(one('.copied')), label = box(tag);
        return [[picture.left - 4, label.top + label.height * .5 + 34], [label.right + 10, label.top + label.height * .5]];
      },
    }),
    // The agent asks: "Nothing goes without that Send", to the Send button itself.
    send: pageArrow({
      host: '.ask', className: 'send-arrow', weight: 18, minWidth: 1041,
      ends(box) {
        const words = box(one('.ask .lede strong')), shot = box(one('.ask .shot'));
        return [[words.left - 12, words.top + words.height * .6], [shot.left + shot.width * .955, shot.top + shot.height * .915]];
      },
    }),
  };
  const layout = () => { for (const arrow of Object.values(arrows)) arrow.layout(); };
  layout();
  addEventListener('resize', layout);
  addEventListener('load', layout);
  document.fonts.ready.then(layout);
  new ResizeObserver(layout).observe(document.body);
  return arrows;
}
