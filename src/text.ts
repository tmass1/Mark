/** Copy Text, the editor's half: Rust reads the lines and where every word
 *  is; this decides what to copy and in what order. Pure, so it is tested on
 *  its own. */

export interface Area { x: number; y: number; width: number; height: number }
export interface TextWord extends Area { text: string }
export interface TextLine extends TextWord { words: TextWord[] }

const middle = (area: Area) => ({ x: area.x + area.width / 2, y: area.y + area.height / 2 });
const inside = (point: { x: number; y: number }, area: Area) =>
  point.x >= area.x && point.x <= area.x + area.width && point.y >= area.y && point.y <= area.y + area.height;

/** The words whose middles lie in the area, each line keeping those it still
 *  has, and its box shrunk to them. A word the edge cuts through goes with
 *  whichever side has most of it. */
export function within(lines: readonly TextLine[], area: Area): TextLine[] {
  return lines.flatMap(line => {
    const words = line.words.length ? line.words.filter(word => inside(middle(word), area))
      : inside(middle(line), area) ? [line] : [];
    if (!words.length) return [];
    const left = Math.min(...words.map(w => w.x)), top = Math.min(...words.map(w => w.y));
    const right = Math.max(...words.map(w => w.x + w.width)), bottom = Math.max(...words.map(w => w.y + w.height));
    return [{ text: words.map(w => w.text).join(' '), x: left, y: top, width: right - left, height: bottom - top, words }];
  });
}

/** Lines that share a row: their heights overlap by more than half the
 *  shorter, as two cells of one table row do. */
function sameRow(a: Area, b: Area): boolean {
  const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlap > Math.min(a.height, b.height) / 2;
}

/** Rows top to bottom, and what shares a row left to right with a tab
 *  between, so a table pastes as a table and a label stays beside its value. */
function rows(lines: readonly TextLine[]): string[] {
  const grouped: TextLine[][] = [];
  for (const line of [...lines].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = grouped.find(candidates => candidates.some(other => sameRow(line, other)));
    if (row) row.push(line); else grouped.push([line]);
  }
  return grouped.map(row => row.sort((a, b) => a.x - b.x).map(line => line.text.trim()).join('\t')).filter(Boolean);
}

/** The widest clear strip running top to bottom between the lines, if one is
 *  wide enough to be a gutter rather than the space between two words: twice
 *  the height of a typical line. */
function gutter(lines: readonly TextLine[]): number | null {
  const spans = [...lines].sort((a, b) => a.x - b.x);
  const heights = lines.map(line => line.height).sort((a, b) => a - b);
  const least = 2 * heights[Math.floor(heights.length / 2)];
  let reach = spans[0].x + spans[0].width, best: { at: number; width: number } | null = null;
  for (const line of spans.slice(1)) {
    const width = line.x - reach;
    if (width >= least && (!best || width > best.width)) best = { at: reach + width / 2, width };
    reach = Math.max(reach, line.x + line.width);
  }
  return best?.at ?? null;
}

/** The text in reading order. A page split by a gutter whose two sides do
 *  not keep rows together -- a sidebar beside its content -- is read a side
 *  at a time; a table's columns keep their rows, so a table stays a table. */
function ordered(lines: readonly TextLine[]): string[] {
  if (lines.length < 2) return rows(lines);
  const at = gutter(lines);
  if (at !== null) {
    const left = lines.filter(line => line.x + line.width <= at), right = lines.filter(line => line.x >= at);
    const [fewer, more] = left.length <= right.length ? [left, right] : [right, left];
    const kept = fewer.filter(line => more.some(other => sameRow(line, other))).length;
    if (kept / fewer.length < 0.7) return [...ordered(left), ...ordered(right)];
  }
  return rows(lines);
}

export function readingOrder(lines: readonly TextLine[]): string {
  return ordered(lines).join('\n');
}
