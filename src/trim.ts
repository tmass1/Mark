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
 *  to its start from anywhere before it; and over any part cut out. */
export function playFrom(at: number, trim: Trim, cuts: readonly Trim[] = []): number {
  const from = at < trim.start || at >= trim.end - 0.01 ? trim.start : at;
  const past = skip(from, cuts);
  return past >= trim.end - 0.01 ? skip(trim.start, cuts) : past;
}

// ---- parts cut out of the middle ------------------------------------------

/** How long a new cut is, and the shortest one may be. */
export const CUT = 1;
export const SHORTEST_CUT = 0.2;

/** What is kept between the handles, once the cuts are taken out: the parts
 *  a copy is made of, in order. Cuts are kept in order and apart. */
export function kept(trim: Trim, cuts: readonly Trim[]): Trim[] {
  const parts: Trim[] = [];
  let from = trim.start;
  for (const cut of cuts) {
    if (cut.start > from) parts.push({ start: from, end: Math.min(cut.start, trim.end) });
    from = Math.max(from, cut.end);
  }
  if (trim.end > from) parts.push({ start: from, end: trim.end });
  return parts.filter(part => part.end - part.start > 1e-6);
}

export function keptLength(trim: Trim, cuts: readonly Trim[]): number {
  return kept(trim, cuts).reduce((sum, part) => sum + part.end - part.start, 0);
}

/** Past any cut `at` is in: where playing goes on from. */
export function skip(at: number, cuts: readonly Trim[]): number {
  let to = at;
  for (const cut of cuts) if (to >= cut.start && to < cut.end) to = cut.end;
  return to;
}

/** A new cut, CUT long around `at`, inside the handles and clear of the other
 *  cuts -- shorter where there is less room -- or null where there is no room,
 *  or it would leave less than SHORTEST kept. */
export function addCut(trim: Trim, cuts: readonly Trim[], at: number): Trim[] | null {
  if (!Number.isFinite(at) || at < trim.start || at > trim.end) return null;
  const before = cuts.filter(cut => cut.end <= at).at(-1);
  const after = cuts.find(cut => cut.start > at);
  if (cuts.some(cut => at >= cut.start && at < cut.end)) return null;
  const low = before ? before.end : trim.start, high = after ? after.start : trim.end;
  let start = Math.max(low, at - CUT / 2), end = Math.min(high, start + CUT);
  start = Math.max(low, end - CUT);
  if (end - start < SHORTEST_CUT) return null;
  const next = [...cuts, { start, end }].sort((a, b) => a.start - b.start);
  return keptLength(trim, next) >= Math.min(SHORTEST, trim.end - trim.start) ? next : null;
}

/** One end of cut `index` moved to `to`: kept between its neighbours and the
 *  handles, at least SHORTEST_CUT long, and leaving at least SHORTEST kept. */
export function moveCutEdge(trim: Trim, cuts: readonly Trim[], index: number, edge: 'start' | 'end', to: number): Trim[] {
  const cut = cuts[index];
  if (!cut || !Number.isFinite(to)) return [...cuts];
  const low = index > 0 ? cuts[index - 1].end : trim.start;
  const high = index < cuts.length - 1 ? cuts[index + 1].start : trim.end;
  const moved = edge === 'start'
    ? { start: Math.min(Math.max(low, to), cut.end - SHORTEST_CUT), end: cut.end }
    : { start: cut.start, end: Math.max(Math.min(high, to), cut.start + SHORTEST_CUT) };
  const next = cuts.map((other, i) => i === index ? moved : other);
  return keptLength(trim, next) >= Math.min(SHORTEST, trim.end - trim.start) - 1e-9 ? next : [...cuts];
}

/** The cuts still inside the handles once they move: those outside go, those
 *  across a handle are cut back to it, and those left too short go. */
export function fitCuts(trim: Trim, cuts: readonly Trim[]): Trim[] {
  return cuts
    .map(cut => ({ start: Math.max(cut.start, trim.start), end: Math.min(cut.end, trim.end) }))
    .filter(cut => cut.end - cut.start >= SHORTEST_CUT);
}
