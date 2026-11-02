/** Where the pointer was through a recording, as Mark followed it, and when
 *  the button went down and came up, for the halo, fingertip and ripples the
 *  editor shows over the movie -- the same reckoning Rust's movie.rs makes for
 *  every copy, so the two agree. */

/** Seconds in, then x and y in the recording's pixels from its top left. */
export type Track = readonly (readonly [number, number, number])[];

/** How long the pointer may go unseen and still be said to be where it was. */
const STALE = 0.25;

/** Where the pointer was `time` seconds in: between the two moments either
 *  side, in proportion, or at the last one before if that was recent enough.
 *  Null before the track starts or after it ends. */
export function pointerAt(track: Track, time: number): [number, number] | null {
  let low = 0, high = track.length;
  while (low < high) { const mid = (low + high) >> 1; if (track[mid][0] <= time) low = mid + 1; else high = mid; }
  const before = track[low - 1], after = track[low];
  if (!before) return null;
  const [at, x, y] = before;
  if (after && after[0] - at <= STALE) {
    const share = after[0] > at ? (time - at) / (after[0] - at) : 0;
    return [x + (after[1] - x) * share, y + (after[2] - y) * share];
  }
  return time - at <= STALE ? [x, y] : null;
}

/** Seconds in that the button went down, and came up, for each press. */
export type Presses = readonly (readonly [number, number])[];

/** A press too quick to see -- a trackpad's tap is over in a hundredth of a
 *  second -- is shown pressed for this long; and a ripple runs for this long.
 *  movie.rs times them the same. */
export const PRESS_SHORTEST = 0.12;
export const RIPPLE_TIME = 0.45;

/** Whether the button is down `time` seconds in, as the fingertip shows it. */
export function pressedAt(presses: Presses, time: number): boolean {
  return presses.some(([down, up]) => down <= time && time < Math.max(up, down + PRESS_SHORTEST));
}

/** The ripples under way `time` seconds in: when each began, and how far
 *  through it is, 0 to 1. */
export function ripplesAt(presses: Presses, time: number): [number, number][] {
  return presses.filter(([down]) => down <= time && time < down + RIPPLE_TIME)
    .map(([down]) => [down, (time - down) / RIPPLE_TIME]);
}

/** How wide a ripple is, as a share of its widest, and how solid, `progress`
 *  through it: quick to spread, slowing as it fades. */
export function rippleShape(progress: number): [number, number] {
  const p = Math.min(1, Math.max(0, progress));
  return [0.35 + 0.65 * (1 - (1 - p) ** 2), 1 - p];
}
