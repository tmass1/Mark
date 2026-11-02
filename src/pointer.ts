/** Where the pointer was through a recording, as Mark followed it, for the
 *  halo the editor shows over the movie -- the same reckoning Rust's
 *  movie::pointer_at makes for every copy, so the two agree. */

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
