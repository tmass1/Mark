/** How a numbered mark and Mark's own arrow look: four styles, one chosen for the
 *  whole capture, as the notes' mode is. Everything here is numbers -- the overlay
 *  and the export each draw from the same look, so what is copied is what was
 *  shown -- and pure, so it is tested on its own.
 *
 *  Lengths are in units, as the designs were drawn: a pill is 34 of them high. A
 *  mark's weight sets how big a unit is, so all of it scales together. */
export type NoteStyle = 'smoked' | 'solid' | 'card' | 'icon';
export const NOTE_STYLES: readonly NoteStyle[] = ['smoked', 'solid', 'card', 'icon'];
export const DEFAULT_NOTE_STYLE: NoteStyle = 'smoked';
export const NOTE_STYLE_NAMES: Record<NoteStyle, string> = { smoked: 'Smoked glass', solid: 'Soft solid', card: 'Card', icon: 'Icon glass' };
export const isNoteStyle = (value: unknown): value is NoteStyle => NOTE_STYLES.includes(value as NoteStyle);

/** How high a pill is, and how far across the disc its number sits in. */
export const UNITS_HIGH = 34;
export const DISC = 22;
/** How far in from the pill's end the disc is, which centres it on that end. */
export const DISC_INSET = (UNITS_HIGH - DISC) / 2;
/** A number with no words needs no room for a line of type, so it is smaller, with
 *  a smaller shadow to match: it should not outweigh the arrow it points with. */
export const BADGE_HIGH = 24;
export const BADGE_DISC = 19;
export const BADGE_CAST = 0.7;

type Point = [number, number];
/** A position along a gradient, 0 to 1, and a colour. */
export type Stop = [number, string];
/** A shadow, in units: how far down, how soft -- a standard deviation -- and its colour. */
export interface Cast { y: number; sigma: number; color: string }
export interface ArrowLook {
  tail: number; neck: number; headLength: number; headWidth: number;
  /** How far back along the head its barbs sit, as a share of its length. */
  swept: number; tipRound: number; barbRound: number;
  /** How far under its frame it starts. A pane that lets the screen through would
   *  let this through as well, so one that does starts at its edge. */
  tuck: number;
  /** From the tail to the tip. */
  fill: Stop[];
  /** A solid edge outside it. */
  edge: { width: number; color: string } | null;
  /** Or a lit one along it, from the tail to the tip. */
  lit: Stop[] | null;
  casts: Cast[];
}
export interface NoteLook {
  /** The weight of the words. */
  weight: number; wordsSize: number; wordsInk: string;
  /** The frame's corners, as a share of its half height; 1 is a pill. */
  corner: number;
  /** Top to bottom, and any light laid over it. */
  frame: Stop[]; gloss: Stop[] | null;
  /** A solid edge outside the frame. */
  ring: { width: number; color: string } | null;
  /** A hairline inside it, top to bottom. */
  rim: { width: number; stops: Stop[] } | null;
  casts: Cast[];
  numberFill: Stop[]; numberInk: string;
  /** The number's corners, as a share of the disc's radius; 1 is round. */
  numberCorner: number;
  numberRim: { width: number; color: string } | null;
  /** The space after the number, and after the words. */
  gap: number; end: number;
  arrow: ArrowLook;
}

const hexOf = (color: string): [number, number, number] | null => {
  const match = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return [value >> 16, (value >> 8) & 255, value & 255];
};
/** A colour towards white, by a share of the way, or towards black if negative.
 *  Anything but a six-digit hex stays as it is. */
export function shade(color: string, by: number): string {
  const rgb = hexOf(color);
  if (!rgb) return color;
  const towards = by < 0 ? 0 : 255, share = Math.abs(by);
  const [r, g, b] = rgb.map(channel => Math.round(channel + (towards - channel) * share));
  return `#${[r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}
/** A colour with an opacity. */
export function faded(color: string, opacity: number): string {
  const rgb = hexOf(color);
  return rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${opacity})` : color;
}
const BLACK = '#000000', WHITE = '#ffffff', INK = '#1c1c1e';
/** How much of the screen the smoked pane keeps out: enough to read on anything, and
 *  little enough that the screen is still felt behind it. */
const SMOKE = 0.88;
const isWhite = (color: string) => color.toLowerCase() === WHITE;
const isBlack = (color: string) => color.toLowerCase() === INK;

/** A style in a colour. `ink` is what reads on that colour. */
export function noteLook(style: NoteStyle, color: string, ink: string): NoteLook {
  if (style === 'solid') {
    const edge = isWhite(color) ? faded(INK, 0.85) : WHITE;
    const casts = [{ y: 6, sigma: 8, color: faded(shade(color, -0.3), 0.32) }, { y: 1, sigma: 1, color: faded(BLACK, 0.16) }];
    return {
      weight: 600, wordsSize: 15.5, wordsInk: ink, corner: 1,
      frame: [[0, shade(color, 0.14)], [0.55, color], [1, shade(color, -0.08)]],
      gloss: [[0, faded(WHITE, ink === WHITE ? 0.3 : 0.45)], [0.05, faded(WHITE, 0)]],
      ring: { width: 1.5, color: edge }, rim: null, casts,
      numberFill: [[0, faded(ink === WHITE ? WHITE : INK, ink === WHITE ? 0.24 : 0.14)]], numberInk: ink, numberCorner: 1, numberRim: null, gap: 8, end: 14,
      arrow: { tail: 2.4, neck: 4.8, headLength: 15, headWidth: 7.6, swept: 0.84, tipRound: 1.5, barbRound: 1.5, tuck: 2,
               fill: [[0, shade(color, 0.18)], [1, shade(color, -0.04)]], edge: { width: 1.5, color: edge }, lit: null, casts },
    };
  }
  if (style === 'card') {
    const white = isWhite(color);
    return {
      weight: 600, wordsSize: 15, wordsInk: INK, corner: 9 / 17,
      frame: [[0, WHITE]], gloss: null, ring: { width: 0.75, color: faded(BLACK, 0.09) }, rim: null,
      casts: [{ y: 10, sigma: 14, color: faded(BLACK, 0.22) }, { y: 2, sigma: 3, color: faded(BLACK, 0.12) }],
      numberFill: white ? [[0, INK]] : [[0, shade(color, 0.1)], [1, shade(color, -0.05)]], numberInk: white ? WHITE : ink,
      numberCorner: 6.5 / 11, numberRim: null, gap: 8, end: 12,
      arrow: { tail: 2.4, neck: 2.4, headLength: 11, headWidth: 5.2, swept: 1, tipRound: 0.5, barbRound: 0.7, tuck: 2, fill: [[0, color]],
               edge: { width: 1.25, color: white ? faded(INK, 0.85) : faded(WHITE, 0.95) }, lit: null, casts: [{ y: 2, sigma: 2.5, color: faded(BLACK, 0.22) }] },
    };
  }
  if (style === 'icon') {
    const white = isWhite(color), black = isBlack(color);
    return {
      weight: 700, wordsSize: 15.5, wordsInk: ink, corner: 1,
      frame: white ? [[0, WHITE], [1, '#dcdce2']] : [[0, shade(color, 0.3)], [0.5, color], [1, shade(color, -0.14)]],
      gloss: [[0, faded(WHITE, 0.5)], [0.05, faded(WHITE, 0)], [0.93, faded(BLACK, 0)], [1, faded(BLACK, 0.14)]], ring: null, rim: null,
      casts: [{ y: 8, sigma: 10, color: white ? faded(BLACK, 0.3) : faded(color, 0.42) }, { y: 1, sigma: 1, color: faded(BLACK, 0.18) }],
      numberFill: [[0, faded(shade(color, -0.45), white ? 0.2 : 0.32)]], numberInk: ink, numberCorner: 1, numberRim: null, gap: 8, end: 15,
      arrow: { tail: 8, neck: 5.4, headLength: 20, headWidth: 11, swept: 0.82, tipRound: 2.4, barbRound: 2.4, tuck: 2,
               fill: white ? [[0, WHITE], [1, '#dcdce2']] : [[0, shade(color, 0.34)], [0.5, color], [1, shade(color, -0.14)]],
               // White on a light screen and black on a dark one need an edge of the other.
               edge: white ? { width: 1, color: faded(INK, 0.5) } : black ? { width: 1, color: faded(WHITE, 0.55) } : null,
               lit: white || black ? null : [[0, faded(WHITE, 0.55)], [0.5, faded(WHITE, 0.14)], [1, faded(BLACK, 0.12)]],
               casts: [{ y: 5, sigma: 6, color: white ? faded(BLACK, 0.26) : faded(color, 0.38) }, { y: 1, sigma: 1, color: faded(BLACK, 0.16) }] },
    };
  }
  const white = isWhite(color), black = isBlack(color);
  return {
    weight: 500, wordsSize: 15.5, wordsInk: '#f5f5f7', corner: 1,
    frame: [[0, faded('#24262c', SMOKE)], [1, faded('#16181d', SMOKE)]], gloss: null, ring: null,
    rim: { width: 1, stops: [[0, faded(WHITE, 0.3)], [1, faded(WHITE, 0.1)]] },
    casts: [{ y: 8, sigma: 12, color: faded(BLACK, 0.3) }, { y: 1, sigma: 1, color: faded(BLACK, 0.25) }],
    numberFill: [[0, shade(color, 0.12)], [1, shade(color, -0.05)]], numberInk: ink, numberCorner: 1,
    // A black number would vanish into the pane.
    numberRim: black ? { width: 1, color: faded(WHITE, 0.4) } : null, gap: 9, end: 14,
    arrow: { tail: 3, neck: 3.4, headLength: 13, headWidth: 6.2, swept: 0.86, tipRound: 0.9, barbRound: 1, tuck: 0, fill: [[0, color]],
             edge: { width: 0.75, color: black ? faded(WHITE, 0.7) : white ? faded(INK, 0.6) : faded('#14161b', 0.16) }, lit: null,
             casts: [{ y: 2, sigma: 3, color: faded(BLACK, 0.32) }] },
  };
}

// ---- the arrow's course ----------------------------------------------------------

const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const mul = (a: Point, by: number): Point => [a[0] * by, a[1] * by];
const lengthOf = (a: Point) => Math.hypot(a[0], a[1]);
const unit = (a: Point): Point => { const length = lengthOf(a) || 1; return [a[0] / length, a[1] / length]; };
const perp = (a: Point): Point => [-a[1], a[0]];
const lerp = (a: Point, b: Point, t: number): Point => add(a, mul(sub(b, a), t));

/** A curve from a mark to where it points. */
export interface Course { from: Point; c1: Point; c2: Point; to: Point }
export interface Frame { x: number; y: number; width: number; height: number }

/** Leaving a frame for a point: out of its rounded end when the point is well
 *  past it, otherwise square off its top or bottom edge, easing over -- and tucked
 *  under the frame by `inset`, so the two read as one thing. Null for a point
 *  inside the frame, which there is no arrow to. */
export function courseFrom(frame: Frame, to: Point, inset: number): Course | null {
  const r = frame.height / 2, right = frame.x + frame.width, bottom = frame.y + frame.height;
  const above = to[1] < frame.y, below = to[1] > bottom;
  const rise = above ? frame.y - to[1] : below ? to[1] - bottom : 0;
  const pastRight = to[0] - right, pastLeft = frame.x - to[0];
  if (!above && !below && pastRight <= 0 && pastLeft <= 0) return null;
  // A badge has no long edge to run along, so it always leaves as a wheel would.
  const round = frame.width <= frame.height * 1.05;
  if (round || pastRight > rise * 0.6 || pastLeft > rise * 0.6) {
    const onRight = round ? to[0] >= frame.x + r : pastRight > pastLeft;
    const centre: Point = [onRight ? right - r : frame.x + r, frame.y + r];
    const out = unit(sub(to, centre)), from = add(centre, mul(out, r - inset)), length = lengthOf(sub(to, from)), side = perp(out);
    const lift = (out[0] * out[1] > 0) === onRight ? -1 : 1;
    const bow = mul(side, lift * length * 0.05);
    return { from, c1: add(add(from, mul(out, length * 0.34)), bow), c2: add(lerp(to, from, 0.3), bow), to };
  }
  const low = frame.x + r, high = Math.max(low, right - r), middle = frame.x + frame.width / 2;
  const x = Math.min(Math.max(to[0] - (to[0] > middle ? 1 : -1) * rise * 0.55, low), high);
  const from: Point = [x, above ? frame.y + inset : bottom - inset];
  const length = lengthOf(sub(to, from));
  return { from, c1: [x, from[1] + (above ? -1 : 1) * Math.min(length * 0.42, rise * 0.7)], c2: lerp(to, from, 0.36), to };
}

/** An arrow on its own: a gentle bow, always rising. */
export function courseAlone(from: Point, to: Point): Course {
  const along = sub(to, from), side = perp(unit(along)), length = lengthOf(along);
  const bow = mul(side, (side[1] > 0 ? -1 : 1) * length * 0.08);
  return { from, c1: add(add(from, mul(along, 0.33)), bow), c2: add(add(from, mul(along, 0.7)), bow), to };
}

const SAMPLES = 20;
const cubic = (a: Point, b: Point, c: Point, d: Point, t: number): Point => {
  const u = 1 - t;
  return [u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
          u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]];
};
const tangent = (a: Point, b: Point, c: Point, d: Point, t: number): Point => {
  const u = 1 - t, first = 3 * u * u, second = 6 * u * t, third = 3 * t * t;
  return unit([first * (b[0] - a[0]) + second * (c[0] - b[0]) + third * (d[0] - c[0]),
               first * (b[1] - a[1]) + second * (c[1] - b[1]) + third * (d[1] - c[1])]);
};
/** A corner softened over `reach` along each side, in short edges. */
function softened(before: Point, at: Point, after: Point, reach: number, steps = 3): Point[] {
  const start = add(at, mul(unit(sub(before, at)), reach)), end = add(at, mul(unit(sub(after, at)), reach));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps, u = 1 - t;
    return [u * u * start[0] + 2 * u * t * at[0] + t * t * end[0], u * u * start[1] + 2 * u * t * at[1] + t * t * end[1]] as Point;
  });
}

/** The arrow along a course, as one polygon -- short edges, so the overlay, the
 *  export and an edge round it need nothing new -- `scale` being the image's pixels
 *  to a unit. Its tip is a point of it, exactly where it was aimed. Null for a
 *  course too short to hold its own head. */
export function curvedArrow(course: Course, look: ArrowLook, scale: number): Point[] | null {
  const { from, c1, c2, to } = course;
  const headLength = look.headLength * scale, headWidth = look.headWidth * scale;
  if (lengthOf(sub(to, from)) < headLength * 1.3) return null;
  const direction = unit(sub(to, c2)), normal = perp(direction);
  const neckAt = sub(to, mul(direction, headLength)), bend = add(neckAt, sub(c2, to));
  const left: Point[] = [], right: Point[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES, at = cubic(from, c1, bend, neckAt, t), side = perp(tangent(from, c1, bend, neckAt, t));
    const half = (look.tail + (look.neck - look.tail) * t) * scale / 2;
    left.push(add(at, mul(side, half))); right.push(sub(at, mul(side, half)));
  }
  const barbs = sub(to, mul(direction, headLength * look.swept));
  const barbLeft = add(barbs, mul(normal, headWidth)), barbRight = sub(barbs, mul(normal, headWidth));
  // A rounded tip stops short of its corner, so the corner is set beyond the aim.
  const half = Math.atan2(headWidth, headLength * look.swept);
  const apex = add(to, mul(direction, look.tipRound * scale * 0.5 * Math.cos(half)));
  const tip = softened(barbLeft, apex, barbRight, look.tipRound * scale, 4);
  tip[2] = to;
  const lead = tangent(from, c1, bend, neckAt, 0), radius = (look.tail * scale) / 2, leadSide = perp(lead);
  // Round the tail, from the right side back to the left.
  const cap = Array.from({ length: 5 }, (_, i) => {
    const angle = Math.PI * ((i + 1) / 6);
    return add(from, add(mul(leadSide, -Math.cos(angle) * radius), mul(lead, -Math.sin(angle) * radius)));
  });
  return [...left, ...softened(left[SAMPLES], barbLeft, tip[0], look.barbRound * scale), ...tip,
          ...softened(tip[4], barbRight, right[SAMPLES], look.barbRound * scale), ...right.reverse(), ...cap];
}
