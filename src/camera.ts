/** Zooming in on a recording: where the picture moves in around a burst of
 *  clicks, follows the pointer, and moves back out. Worked out here alone --
 *  the editor shows it from cameraAt as the movie plays, and sends Rust
 *  cameraTrack, which it only follows -- so what plays is what is copied.
 *  Pure, so it is tested on its own. */
import { pointerAt, type Presses, type Track } from './pointer';
import type { Trim } from './trim';

/** A stretch of the recording seen closer: from `start` to `end`, in its own
 *  seconds, `scale` times closer at its closest. */
export interface Zoom { start: number; end: number; scale: number }
/** Where the picture is seen from: the middle of the view, on the canvas the
 *  copy comes out on, and how much closer than the whole of it. */
export interface Camera { x: number; y: number; scale: number }

/** How close a zoom may come; a new one comes to 1.5×, which reads as a
 *  camera leaning in rather than a jump. */
export const LEVELS = [1.5, 2, 3] as const;
export const SCALE = 1.5;
/** How long the picture takes to move in, and back out: unhurried. */
export const RAMP = 0.9;
/** A zoom is at least long enough to go in and come out. */
export const SHORTEST_ZOOM = 2 * RAMP;
/** A zoom suggested for a burst starts this long before its first click, so
 *  it is in by then, and ends this long after its last; clicks this close
 *  together are one burst, so the view stays in rather than bobbing. */
const LEAD = 1;
const HOLD = 2;
const BURST = 4;
/** The pointer is followed as it was over this long either side, so the view
 *  glides after it rather than shaking with every twitch. */
const FOLLOW = 0.6;
/** Frames a second in the track Rust follows. */
export const CAMERA_RATE = 30;

/** A zoom round each burst of clicks in what is kept, overlapping ones as one. */
export function suggestZooms(presses: Presses, trim: Trim, scale = SCALE): Zoom[] {
  const kept = [...presses].filter(([down]) => down >= trim.start && down < trim.end).sort((a, b) => a[0] - b[0]);
  const zooms: Zoom[] = [];
  let lastUp = -Infinity;
  for (const [down, up] of kept) {
    const last = zooms[zooms.length - 1];
    if (last && down - lastUp < BURST) last.end = up + HOLD;
    else zooms.push({ start: down - LEAD, end: up + HOLD, scale });
    lastUp = Math.max(lastUp, up);
  }
  const held = zooms.map(zoom => ({ ...zoom, start: Math.max(trim.start, zoom.start), end: Math.min(trim.end, zoom.end) }));
  return merge(held).filter(zoom => zoom.end - zoom.start >= SHORTEST_ZOOM);
}

/** In order, and any that overlap as one, at the closer of their levels; two
 *  that only touch stay two. */
export function merge(zooms: Zoom[]): Zoom[] {
  const sorted = [...zooms].sort((a, b) => a.start - b.start);
  const merged: Zoom[] = [];
  for (const zoom of sorted) {
    const last = merged[merged.length - 1];
    if (last && zoom.start < last.end) { last.end = Math.max(last.end, zoom.end); last.scale = Math.max(last.scale, zoom.scale); }
    else merged.push({ ...zoom });
  }
  return merged;
}

/** A zoom of a couple of seconds round `at`, fitted in among the others and
 *  inside what is kept -- or null where there is no room for one. */
export function addZoom(zooms: Zoom[], trim: Trim, at: number, length = 2): Zoom[] | null {
  let start = Math.max(trim.start, at - length / 2);
  let end = Math.min(trim.end, start + length);
  start = Math.max(trim.start, end - length);
  const before = zooms.filter(zoom => zoom.end <= at).reduce((most, zoom) => Math.max(most, zoom.end), -Infinity);
  const after = zooms.filter(zoom => zoom.start > at).reduce((least, zoom) => Math.min(least, zoom.start), Infinity);
  if (zooms.some(zoom => zoom.start <= at && at < zoom.end)) return null;
  start = Math.max(start, before); end = Math.min(end, after);
  if (end - start < SHORTEST_ZOOM) return null;
  return merge([...zooms, { start, end, scale: SCALE }]);
}

/** One end of a zoom dragged to `to`: kept clear of its neighbours, inside
 *  what is kept, and never shorter than it takes to go in and come out. */
export function moveZoomEdge(zooms: Zoom[], trim: Trim, index: number, edge: 'start' | 'end', to: number): Zoom[] {
  const zoom = zooms[index];
  if (!zoom) return zooms;
  const floor = Math.max(trim.start, zooms[index - 1]?.end ?? -Infinity);
  const ceiling = Math.min(trim.end, zooms[index + 1]?.start ?? Infinity);
  const moved = edge === 'start'
    ? { ...zoom, start: Math.min(Math.max(to, floor), zoom.end - SHORTEST_ZOOM) }
    : { ...zoom, end: Math.max(Math.min(to, ceiling), zoom.start + SHORTEST_ZOOM) };
  return zooms.map((other, i) => (i === index ? moved : other));
}

/** Eased: slow to leave, slow to arrive. */
const ease = (t: number) => t * t * (3 - 2 * t);

/** Where the pointer was on average about `time`, on the recording. */
function followed(track: Track, time: number): [number, number] | null {
  let low = 0, high = track.length;
  while (low < high) { const mid = (low + high) >> 1; if (track[mid][0] < time - FOLLOW) low = mid + 1; else high = mid; }
  let x = 0, y = 0, count = 0;
  for (let i = low; i < track.length && track[i][0] <= time + FOLLOW; i++) { x += track[i][1]; y += track[i][2]; count++; }
  return count ? [x / count, y / count] : pointerAt(track, time);
}

/** The camera `time` seconds in, on a canvas `width` × `height`: the whole of
 *  it outside a zoom; in one, easing in and out, its middle on where the
 *  pointer was, `place` taking that from the recording onto the canvas -- and
 *  held so the view never leaves the picture. */
export function cameraAt(time: number, zooms: Zoom[], track: Track, canvas: { width: number; height: number },
                         place: (point: [number, number]) => [number, number] = point => point): Camera {
  const whole = { x: canvas.width / 2, y: canvas.height / 2, scale: 1 };
  const zoom = zooms.find(each => each.start <= time && time < each.end);
  if (!zoom) return whole;
  const ramp = Math.min(RAMP, (zoom.end - zoom.start) / 2);
  const share = Math.min(1, (time - zoom.start) / ramp, (zoom.end - time) / ramp);
  const scale = 1 + (zoom.scale - 1) * ease(Math.max(0, share));
  const pointer = followed(track, time);
  const [x, y] = pointer ? place(pointer) : [whole.x, whole.y];
  const half = { width: canvas.width / scale / 2, height: canvas.height / scale / 2 };
  const hold = (value: number, half: number, side: number) => Math.min(Math.max(value, half), side - half);
  return { x: hold(x, half.width, canvas.width), y: hold(y, half.height, canvas.height), scale };
}

/** The camera through every zoom, so many times a second, for Rust to follow:
 *  seconds in, the view's middle, and how close. Nothing outside a zoom,
 *  which Rust takes as the whole picture. */
export function cameraTrack(zooms: Zoom[], track: Track, canvas: { width: number; height: number },
                            place?: (point: [number, number]) => [number, number]): [number, number, number, number][] {
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return zooms.flatMap(zoom => {
    const count = Math.max(1, Math.ceil((zoom.end - zoom.start) * CAMERA_RATE));
    return Array.from({ length: count + 1 }, (_, i) => {
      const at = Math.min(zoom.end, zoom.start + i / CAMERA_RATE);
      const camera = i === count ? { x: canvas.width / 2, y: canvas.height / 2, scale: 1 } : cameraAt(at, [zoom], track, canvas, place);
      return [round(at), round(camera.x), round(camera.y), round(camera.scale)] as [number, number, number, number];
    });
  });
}
