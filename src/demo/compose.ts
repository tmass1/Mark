/** A copy of a recording, in a browser: what movie.rs's composition does for the
 *  app, frame by frame on a canvas. What is cut and how fast, the redactions, what
 *  Mark draws of the pointer, the marks, the frame and the camera, in that order
 *  and from the numbers the editor sends Rust, so a copy is what the editor shows. */
import { recordsArrow, type Look } from '../look';
import { pointerAt, pressedAt, rippleShape, ripplesAt } from '../pointer';
import type { Take } from './recorder';

export interface Hidden { x: number; y: number; width: number; height: number; at: number; until?: number; block: number }
export interface Marks {
  overlays?: { at: number; png: string }[];
  redactions?: Hidden[];
  frame?: { width: number; height: number; x: number; y: number; under: string; mask: string; over?: string };
  camera?: [number, number, number, number][];
}
export interface Part { start: number; end: number }

/** A mark is due a frame early rather than a frame late. As movie.rs. */
const DUE = 1 / 60;
/** How far the halo reaches, the fingertip's radius and a ripple's widest, in points. */
const HALO = 28, TOUCH = 20, RIPPLE = 30;
const TOUCH_GREY = '120, 120, 128';
const TOUCH_RIM_SHARE = 0.075, TOUCH_PRESSED = 0.88, RIPPLE_STROKE = 0.08, RIPPLE_SOLID = 0.75;
/** The largest frame H.264 takes everywhere. */
const LARGEST = [3840, 2160];
const SMALL_GIF = { rate: 10, longest: 640 }, GIF = { rate: 15, longest: 1280 };

/** What is kept between the handles, less what is cut out of it. As Timeline::new. */
export function partsOf(start: number, end: number, cuts: readonly (readonly [number, number])[]): Part[] {
  const parts: Part[] = [];
  let from = start;
  for (const [cutStart, cutEnd] of cuts) {
    if (cutStart > from + 1e-3) parts.push({ start: from, end: cutStart });
    from = cutEnd;
  }
  if (end > from + 1e-3) parts.push({ start: from, end });
  return parts;
}
/** How long a copy of them runs. */
export const lengthOf = (parts: readonly Part[], speed: number) => parts.reduce((sum, part) => sum + part.end - part.start, 0) / speed;
/** Where the moment `time` seconds into a copy is in the recording. */
export function sourceAt(parts: readonly Part[], speed: number, time: number): number {
  let left = Math.max(0, time) * speed;
  for (const part of parts) {
    const length = part.end - part.start;
    if (left < length) return part.start + left;
    left -= length;
  }
  return parts[parts.length - 1]?.end ?? time;
}
/** The newest of the marks' moments due by `time`, or -1. */
export function overlayAt(moments: readonly number[], time: number): number {
  for (let i = moments.length - 1; i >= 0; i--) if (moments[i] <= time + DUE) return i;
  return -1;
}
/** The camera `time` seconds in, between the samples either side if they are of
 *  one zoom, and null where there is none, which is the whole picture. */
export function cameraAt(track: readonly (readonly [number, number, number, number])[], time: number): [number, number, number] | null {
  const APART = 0.11;
  let after = track.findIndex(sample => sample[0] > time);
  if (after < 0) after = track.length;
  const now = track[after - 1];
  if (!now) return null;
  const [at, x, y, scale] = now, next = track[after];
  let view: [number, number, number];
  if (next && next[0] - at <= APART) {
    const share = next[0] > at ? (time - at) / (next[0] - at) : 0;
    view = [x + (next[1] - x) * share, y + (next[2] - y) * share, scale + (next[3] - scale) * share];
  } else if (time === at) view = [x, y, scale];
  else return null;
  return view[2] > 1 + 1e-6 ? view : null;
}
/** The size a copy comes out: the recording's, or the frame's, fitted to what
 *  H.264 takes, in even pixels. */
export function outputSize(width: number, height: number): [number, number] {
  const fit = Math.min(LARGEST[0] / width, LARGEST[1] / height, 1);
  const even = (side: number) => Math.max(2, Math.floor(side * fit / 2) * 2);
  return [even(width), even(height)];
}
/** The frames of a GIF of what is kept: the moments in the recording, how long
 *  each shows, and how large it may be. As gif_plan. */
export function gifPlan(parts: readonly Part[], speed: number, pixels: [number, number], scale: number, small: boolean) {
  const { rate, longest } = small ? SMALL_GIF : GIF;
  const delay = 1 / rate;
  const count = Math.max(1, Math.round(lengthOf(parts, speed) / delay));
  const times = Array.from({ length: count }, (_, i) => sourceAt(parts, speed, i * delay));
  const [width, height] = [pixels[0] / Math.max(scale, 1), pixels[1] / Math.max(scale, 1)];
  const fit = Math.min(longest / Math.max(width, height), 1);
  return { times, delay, size: [Math.max(1, Math.round(width * fit)), Math.max(1, Math.round(height * fit))] as [number, number] };
}

const png = (base64: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image); image.onerror = () => reject('What was drawn couldn’t be read.');
  image.src = `data:image/png;base64,${base64}`;
});
const blank = (width: number, height: number) => Object.assign(document.createElement('canvas'), { width, height });

export interface Composer { width: number; height: number; draw(video: HTMLVideoElement, time: number, target: CanvasRenderingContext2D, width: number, height: number): void }

/** Ready to draw a frame of `take` as asked: its pictures read once. */
export async function composer(take: Take, look: Look, marks: Marks | null): Promise<Composer> {
  const overlays = await Promise.all((marks?.overlays ?? []).map(async overlay => ({ at: overlay.at, image: await png(overlay.png) })));
  overlays.sort((a, b) => a.at - b.at);
  const moments = overlays.map(overlay => overlay.at);
  const framing = marks?.frame;
  const plates = framing && {
    under: await png(framing.under), mask: await png(framing.mask), over: framing.over ? await png(framing.over) : null,
  };
  const movie = blank(take.width, take.height), context = movie.getContext('2d', { willReadFrequently: false })!;
  const canvas = framing ? blank(framing.width, framing.height) : movie;
  const canvasContext = canvas.getContext('2d')!;
  const screen = framing ? blank(framing.width, framing.height) : null;
  const small = document.createElement('canvas');
  const arrow = recordsArrow(take.look.pointer);
  const halo = look.pointer === 'halo' && arrow ? HALO * take.scale : 0;
  const touch = look.pointer === 'touch' && !arrow ? TOUCH * take.scale : 0;
  const ripple = look.clicks === 'ripple' && take.look.clicks !== 'rings' && take.presses.length ? RIPPLE * take.scale : 0;
  const [width, height] = outputSize(canvas.width, canvas.height);

  const disc = (x: number, y: number, radius: number, fill: string) => {
    context.fillStyle = fill; context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
  };
  const ring = (x: number, y: number, inner: number, outer: number, fill: string) => {
    context.fillStyle = fill; context.beginPath(); context.arc(x, y, outer, 0, Math.PI * 2); context.arc(x, y, Math.max(0, inner), 0, Math.PI * 2, true); context.fill();
  };

  return {
    width, height,
    draw(video, time, target, outWidth, outHeight) {
      context.drawImage(video, 0, 0, movie.width, movie.height);
      for (const part of marks?.redactions ?? []) {
        if (!(part.at <= time + DUE && (part.until === undefined || time + DUE < part.until))) continue;
        const block = Math.max(2, part.block);
        small.width = Math.max(1, Math.round(part.width / block)); small.height = Math.max(1, Math.round(part.height / block));
        small.getContext('2d')!.drawImage(movie, part.x, part.y, part.width, part.height, 0, 0, small.width, small.height);
        context.imageSmoothingEnabled = false;
        context.drawImage(small, 0, 0, small.width, small.height, part.x, part.y, part.width, part.height);
        context.imageSmoothingEnabled = true;
      }
      // The pointer under the marks, so an arrow at it stays sharp.
      if (ripple) for (const [down, progress] of ripplesAt(take.presses, time)) {
        const from = pointerAt(take.track, down);
        if (!from) continue;
        const [share, solid] = rippleShape(progress), outer = ripple * share;
        ring(from[0], from[1], outer - ripple * RIPPLE_STROKE, outer, `rgba(${TOUCH_GREY}, ${RIPPLE_SOLID * solid})`);
      }
      const at = pointerAt(take.track, time);
      if (at && halo) {
        const glow = context.createRadialGradient(at[0], at[1], halo * 0.35, at[0], at[1], halo);
        glow.addColorStop(0, 'rgba(255, 214, 10, .42)'); glow.addColorStop(1, 'rgba(255, 214, 10, 0)');
        disc(at[0], at[1], halo, glow as unknown as string);
      }
      if (at && touch) {
        const pressed = pressedAt(take.presses, time), radius = pressed ? touch * TOUCH_PRESSED : touch;
        const inner = radius * (1 - TOUCH_RIM_SHARE);
        disc(at[0], at[1], inner, `rgba(${TOUCH_GREY}, ${pressed ? 0.5 : 0.3})`);
        ring(at[0], at[1], inner, radius, `rgba(255, 255, 255, ${pressed ? 0.9 : 0.7})`);
      }
      const due = overlayAt(moments, time);
      if (due >= 0) context.drawImage(overlays[due].image, 0, 0, movie.width, movie.height);
      // Framed: set on the canvas, showing through the screen over what lies under it.
      if (framing && plates && screen) {
        const glass = screen.getContext('2d')!;
        glass.globalCompositeOperation = 'source-over';
        glass.clearRect(0, 0, screen.width, screen.height);
        glass.drawImage(plates.mask, 0, 0);
        glass.globalCompositeOperation = 'source-in';
        glass.drawImage(movie, framing.x, framing.y);
        canvasContext.drawImage(plates.under, 0, 0);
        canvasContext.drawImage(screen, 0, 0);
        if (plates.over) canvasContext.drawImage(plates.over, 0, 0);
      }
      // Seen closer: the view cut from the canvas and brought up to fill it.
      const view = marks?.camera?.length ? cameraAt(marks.camera, time) : null;
      if (view) {
        const [x, y, closer] = view, w = canvas.width / closer, h = canvas.height / closer;
        target.drawImage(canvas, x - w / 2, y - h / 2, w, h, 0, 0, outWidth, outHeight);
      } else target.drawImage(canvas, 0, 0, outWidth, outHeight);
    },
  };
}
