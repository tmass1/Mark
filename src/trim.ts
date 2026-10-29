/** The arithmetic of trimming a recording: which part of it is kept, how the
 *  handles move, and how its times read. Seconds throughout, as a video
 *  element counts them. */

/** The shortest part of a recording that may be kept, as movie.rs holds it to. */
export const SHORTEST = 0.5;
/** An end this close to the start or the finish is that end. */
const NEAR = 0.05;

export interface Trim { start: number; end: number }

/** "0:12", "4:05": a time to the second, as the recording bar counts. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** All of a recording `duration` long. */
export function everything(duration: number): Trim { return { start: 0, end: duration }; }

/** Whether a trim keeps the whole recording, which needs no trimming. */
export function whole(trim: Trim, duration: number): boolean {
  return trim.start <= NEAR && trim.end >= duration - NEAR;
}

/** One end of the trim moved to `to`, kept within the recording and at least
 *  SHORTEST from the other end -- or as far as a recording shorter than that
 *  allows. */
export function moveEdge(trim: Trim, edge: 'start' | 'end', to: number, duration: number): Trim {
  const gap = Math.min(SHORTEST, duration);
  if (!Number.isFinite(to)) return trim;
  return edge === 'start'
    ? { start: Math.min(Math.max(0, to), trim.end - gap), end: trim.end }
    : { start: trim.start, end: Math.max(Math.min(duration, to), trim.start + gap) };
}

/** Where playing goes after `at`: on through the part kept, back to its start
 *  past its end -- it loops, so a trim can be watched until it is right -- and
 *  to its start from anywhere before it. */
export function playFrom(at: number, trim: Trim): number {
  return at < trim.start || at >= trim.end - 0.01 ? trim.start : at;
}
