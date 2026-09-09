/** Annotations drawn over a capture: arrows and text.
 *
 *  Every coordinate is in image-pixel space, never screen space. The overlay is
 *  an SVG whose viewBox matches the capture's natural size, so a drawing keeps
 *  its position when the window resizes and composites at full resolution.
 */

export interface Arrow { kind: 'arrow'; id: number; x1: number; y1: number; x2: number; y2: number; color: string; weight: number }
export interface Note { kind: 'text'; id: number; x: number; y: number; text: string; color: string; size: number }
/** Everything drawn as a rectangle: outlines, marker ink, and redaction. */
export type ShapeKind = 'box' | 'ellipse' | 'highlight' | 'redact';
export interface Shape {
  kind: ShapeKind; id: number; x: number; y: number; width: number; height: number;
  color: string; weight: number;
  /** Redaction only: the pixelated patch, rebuilt when the region settles. */
  pixels?: string;
}
export type Annotation = Arrow | Note | Shape;
export type Tool = 'arrow' | 'text' | ShapeKind | 'crop';

export const SHAPES: readonly ShapeKind[] = ['box', 'ellipse', 'highlight', 'redact'];
export function isShape(item: Annotation): item is Shape { return (SHAPES as readonly string[]).includes(item.kind); }
/** Marker ink has to let the screenshot through. */
export const HIGHLIGHT_ALPHA = 0.3;

/** What to call a kind in a status line. */
export function describe(kind: Annotation['kind']): string {
  return kind === 'text' ? 'Text' : kind === 'redact' ? 'Redaction'
    : kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Shift a copy off its original so the two are distinguishable. */
export function offsetBy<T extends Annotation>(item: T, distance: number): T {
  if (item.kind === 'arrow') {
    return { ...item, x1: item.x1 + distance, y1: item.y1 + distance,
                      x2: item.x2 + distance, y2: item.y2 + distance };
  }
  return { ...item, x: item.x + distance, y: item.y + distance };
}
/** Redaction block size, tied to the size control but floored so a small
 *  setting cannot leave legible text behind. */
export function blockSize(weight: number): number { return Math.max(7, weight * 1.5); }
export type Point = [number, number];

import { clampRect, type Rect } from './region';

const SVG = 'http://www.w3.org/2000/svg';
/** Below this a crop is a mis-drag, not an intention. */
const MIN_CROP = 16;
/** Matches the app's own stack so SVG display and canvas export render alike. */
export const FONT = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, sans-serif';
export const WEIGHT = 600;
export const LINE = 1.25;

export const COLORS = [
  { name: 'Red', value: '#ff3b30' }, { name: 'Orange', value: '#ff9500' },
  { name: 'Yellow', value: '#ffcc00' }, { name: 'Green', value: '#34c759' },
  { name: 'Blue', value: '#007aff' }, { name: 'Purple', value: '#af52de' },
  { name: 'Black', value: '#1c1c1e' }, { name: 'White', value: '#ffffff' },
];

/** A capture's own size sets the default stroke, so an arrow reads the same on a
 *  small region and a Retina full-screen grab. */
export function baseWeight(width: number, height: number): number {
  return Math.min(64, Math.max(5, Math.hypot(width, height) * 0.011));
}
/** Text is sized off the same base, so one slider drives both tools. */
export function textSize(weight: number): number { return weight * 2; }

/** Tapered shaft into a solid head: near a point at the tail, widening to the
 *  head, in the spirit of Skitch's arrow. Seven points, head tip exactly at
 *  (x2, y2) so the arrow lands where the pointer was released. */
export function arrowPolygon(a: Arrow): Point[] {
  const dx = a.x2 - a.x1, dy = a.y2 - a.y1;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length, uy = dy / length;
  const nx = -uy, ny = ux;
  // A short arrow gives up head length before it gives up head width, so it
  // stays recognisable instead of collapsing into a wedge.
  const head = Math.min(a.weight * 3.2, length * 0.44);
  const halfHead = a.weight * 1.5, tailHalf = a.weight * 0.16, baseHalf = a.weight * 0.5;
  const bx = a.x2 - ux * head, by = a.y2 - uy * head;
  const off = (px: number, py: number, d: number): Point => [px + nx * d, py + ny * d];
  return [
    off(a.x1, a.y1, tailHalf), off(bx, by, baseHalf), off(bx, by, halfHead),
    [a.x2, a.y2],
    off(bx, by, -halfHead), off(bx, by, -baseHalf), off(a.x1, a.y1, -tailHalf),
  ];
}

export function polygonPath(points: Point[]): string {
  return points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ') + 'Z';
}

export function lines(note: Note): string[] { return note.text.split('\n'); }

/** Replace a region with coarse blocks sampled from the capture. Averaging down
 *  and blowing back up with smoothing off destroys the detail rather than
 *  smearing it, which is the point: a blur can be partly undone. */
export function pixelateRegion(
  target: CanvasRenderingContext2D, source: CanvasImageSource, shape: Shape,
  /** Where to paint it. Defaults to where it was sampled from; the display
   *  patch draws into a canvas of its own and so starts at the origin. */
  destinationX = shape.x, destinationY = shape.y,
): void {
  const width = Math.max(1, Math.round(shape.width)), height = Math.max(1, Math.round(shape.height));
  const block = blockSize(shape.weight);
  const columns = Math.max(1, Math.round(width / block)), rows = Math.max(1, Math.round(height / block));
  const small = document.createElement('canvas');
  small.width = columns; small.height = rows;
  const reduce = small.getContext('2d');
  if (!reduce) return;
  reduce.drawImage(source, shape.x, shape.y, width, height, 0, 0, columns, rows);
  const smoothing = target.imageSmoothingEnabled;
  target.imageSmoothingEnabled = false;
  target.drawImage(small, 0, 0, columns, rows, destinationX, destinationY, width, height);
  target.imageSmoothingEnabled = smoothing;
}

/** The same pixelation as an image, for the SVG overlay to show, so what is on
 *  screen is what gets copied. */
export function redactionPatch(source: CanvasImageSource, shape: Shape): string | null {
  const width = Math.max(1, Math.round(shape.width)), height = Math.max(1, Math.round(shape.height));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  pixelateRegion(ctx, source, shape, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Paint onto a 2D context at natural size, so the copied PNG matches the screen.
 *  Redaction samples the capture itself, which is why the source is needed. */
export function drawAnnotations(
  ctx: CanvasRenderingContext2D, items: readonly Annotation[], source?: CanvasImageSource,
): void {
  for (const item of items) {
    ctx.fillStyle = item.color;
    if (isShape(item)) {
      const { x, y, width, height } = item;
      if (item.kind === 'redact') { if (source) pixelateRegion(ctx, source, item); continue; }
      if (item.kind === 'highlight') {
        ctx.save();
        ctx.globalAlpha = HIGHLIGHT_ALPHA;
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillRect(x, y, width, height);
        ctx.restore();
        continue;
      }
      ctx.strokeStyle = item.color;
      ctx.lineWidth = item.weight;
      ctx.beginPath();
      if (item.kind === 'ellipse') {
        ctx.ellipse(x + width / 2, y + height / 2, Math.max(width / 2 - item.weight / 2, 0.5),
                    Math.max(height / 2 - item.weight / 2, 0.5), 0, 0, Math.PI * 2);
      } else {
        const inset = item.weight / 2;
        ctx.rect(x + inset, y + inset, Math.max(width - item.weight, 1), Math.max(height - item.weight, 1));
      }
      ctx.stroke();
      continue;
    }
    if (item.kind === 'arrow') {
      const points = arrowPolygon(item);
      ctx.beginPath();
      points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.font = `${WEIGHT} ${item.size}px ${FONT}`;
      ctx.textBaseline = 'top';
      lines(item).forEach((line, i) => ctx.fillText(line, item.x, item.y + i * item.size * LINE));
    }
  }
}

type Corner = 'nw' | 'ne' | 'se' | 'sw';
const CORNERS: readonly Corner[] = ['nw', 'ne', 'se', 'sw'];

type Drag =
  | { kind: 'create'; id: number; ox: number; oy: number }
  | { kind: 'move'; id: number; ox: number; oy: number; from: Annotation[] }
  | { kind: 'reshape'; id: number; end: 1 | 2 }
  | { kind: 'corner'; id: number; corner: Corner; from: Shape }
  | { kind: 'crop'; ox: number; oy: number };

/** The box an annotation occupies, for drawing a selection outline round it. */
function bounds(item: Annotation): { x: number; y: number; width: number; height: number } {
  if (item.kind === 'arrow') {
    return { x: Math.min(item.x1, item.x2), y: Math.min(item.y1, item.y2),
             width: Math.abs(item.x2 - item.x1), height: Math.abs(item.y2 - item.y1) };
  }
  if (item.kind === 'text') return { x: item.x, y: item.y, width: 1, height: 1 };
  return item;
}

/** A rectangle from two opposite points, always with a positive size. */
function span(ax: number, ay: number, bx: number, by: number) {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
}

export interface LayerStyle { color: string; scale: number }

export class AnnotationLayer {
  private items: Annotation[] = [];
  private past: Annotation[][] = [];
  private nextId = 1;
  private drag: Drag | null = null;
  private width = 0;
  private height = 0;
  private handleRadius = 6;
  private editor: HTMLTextAreaElement;
  private editing: number | null = null;
  private editingIsNew = false;
  /** Set only by a press that did not turn into a drag, so a move never arms
   *  the reopen-on-second-click. */
  private lastClick: { id: number; time: number } | null = null;
  private gesture = 0;
  private source: HTMLImageElement | null = null;
  /** Survives a new capture on purpose: the same label often belongs on several
   *  screenshots in a row. */
  private clipboard: Annotation[] = [];
  /** A crop the user is drawing out but has not confirmed. Not an annotation:
   *  it changes the capture rather than sitting on top of it. */
  pendingCrop: Rect | null = null;
  /** Ids, not objects, so reordering and undo cannot leave it holding stale
   *  copies of things that have since been replaced. */
  private chosen = new Set<number>();
  tool: Tool = 'arrow';
  base = 12;
  style: LayerStyle = { color: COLORS[0].value, scale: 1 };

  constructor(private svg: SVGSVGElement, private stage: HTMLElement, private onChange: () => void) {
    svg.addEventListener('pointerdown', this.down);
    svg.addEventListener('pointermove', this.move);
    svg.addEventListener('pointerup', this.up);
    svg.addEventListener('pointercancel', this.up);

    this.editor = document.createElement('textarea');
    this.editor.className = 'text-editor';
    this.editor.hidden = true;
    this.editor.spellcheck = false;
    this.editor.rows = 1;
    this.editor.addEventListener('blur', () => this.commit());
    this.editor.addEventListener('input', () => this.fitEditor());
    this.editor.addEventListener('keydown', event => {
      // Escape keeps what was typed and leaves editing; it must not also close
      // the editor window behind it.
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.commit(); }
      else event.stopPropagation();
    });
    stage.append(this.editor);
  }

  get annotations(): readonly Annotation[] { return this.items; }
  /** Selected annotations, in the order they are drawn. */
  get selection(): Annotation[] { return this.items.filter(item => this.chosen.has(item.id)); }
  /** The sole selection, or null when none or several are chosen. Handles and
   *  text editing only make sense for exactly one. */
  get selected(): number | null {
    return this.chosen.size === 1 ? [...this.chosen][0] : null;
  }
  /** What the toolbar should describe: the last of the selection in draw order. */
  get styleSource(): Annotation | undefined { return this.selection.at(-1); }
  get empty(): boolean { return this.items.length === 0; }
  get canUndo(): boolean { return this.past.length > 0; }
  /** How many annotation edits deep we are, so the editor can tell whether a
   *  crop or a drawing was the more recent thing to undo. */
  get undoDepth(): number { return this.past.length; }
  get isEditing(): boolean { return this.editing !== null; }
  private get weight(): number { return this.base * this.style.scale; }

  clearCrop(): void {
    if (!this.pendingCrop) return;
    this.pendingCrop = null; this.render(); this.onChange();
  }

  /** Follow the image when it is cropped. Deliberately not an undo step: the
   *  editor pairs the shift with the capture it belongs to. */
  shiftBy(dx: number, dy: number): void {
    for (const item of this.items) {
      if (item.kind === 'arrow') { item.x1 += dx; item.y1 += dy; item.x2 += dx; item.y2 += dy; }
      else { item.x += dx; item.y += dy; }
      // Coordinates moved, so every redaction patch is now of the wrong region.
      if (item.kind === 'redact') item.pixels = undefined;
    }
  }

  /** A new size for the same drawing, unlike setImage which starts over. */
  resize(width: number, height: number): void {
    this.width = width; this.height = height;
    this.base = baseWeight(width, height);
    this.pendingCrop = null;
    this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this.measure(); this.render();
  }

  /** Put a saved drawing back, without disturbing the capture it belongs to. */
  load(items: readonly Annotation[]): void {
    this.items = items.map(item => ({ ...item }));
    this.nextId = this.items.reduce((most, item) => Math.max(most, item.id), 0) + 1;
    this.past = []; this.chosen.clear(); this.pendingCrop = null;
    this.render(); this.onChange();
  }

  /** The capture itself, which redaction samples. */
  setSource(source: HTMLImageElement): void { this.source = source; }

  /** Rebuild a redaction's pixels. Deferred until a drag ends: re-encoding the
   *  patch on every pointermove is work nobody sees. */
  private settle(shape: Annotation | undefined): void {
    if (shape?.kind !== 'redact') return;
    const source = this.source;
    if (!source?.complete || !source.naturalWidth) { shape.pixels = undefined; return; }
    shape.pixels = redactionPatch(source, shape) ?? undefined;
  }

  /** The capture finished decoding after a redaction was already drawn on it. */
  refreshRedactions(): void {
    const pending = this.items.filter(item => item.kind === 'redact' && !item.pixels);
    if (!pending.length) return;
    pending.forEach(item => this.settle(item));
    this.render();
  }

  /** Point to the new capture. Drawings never carry across captures. */
  setImage(width: number, height: number): void {
    this.width = width; this.height = height;
    this.base = baseWeight(width, height);
    this.items = []; this.past = []; this.chosen.clear(); this.drag = null;
    this.editing = null; this.editor.hidden = true;
    this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this.measure(); this.render();
  }

  /** Display pixels per image pixel, for anything that must stay a constant size
   *  on screen however large the capture is. */
  private get scale(): number {
    const shown = this.svg.getBoundingClientRect().width;
    return shown > 0 && this.width > 0 ? shown / this.width : 1;
  }

  measure(): void {
    this.handleRadius = 7 / this.scale;
    if (this.editing !== null) this.placeEditor();
    if (this.chosen.size || this.editing !== null) this.render();
  }

  private commitHistory(): void {
    this.past.push(this.items.map(item => ({ ...item })));
    if (this.past.length > 60) this.past.shift();
  }

  undo(): boolean {
    if (this.editing !== null) this.commit();
    const previous = this.past.pop();
    if (!previous) return false;
    this.items = previous;
    // Undo can remove things that were selected; drop them rather than keeping
    // ids that no longer name anything.
    for (const id of [...this.chosen]) { if (!this.find(id)) this.chosen.delete(id); }
    this.render(); this.onChange();
    return true;
  }

  deleteSelected(): boolean {
    if (!this.chosen.size || this.editing !== null) return false;
    this.commitHistory();
    this.items = this.items.filter(item => !this.chosen.has(item.id));
    this.chosen.clear();
    this.render(); this.onChange();
    return true;
  }

  deselect(): boolean {
    if (this.editing !== null) { this.commit(); return true; }
    if (!this.chosen.size) return false;
    this.chosen.clear(); this.render(); this.onChange();
    return true;
  }

  selectAll(): boolean {
    if (this.editing !== null || !this.items.length) return false;
    if (this.chosen.size === this.items.length) return false;
    this.items.forEach(item => this.chosen.add(item.id));
    this.render(); this.onChange();
    return true;
  }

  /** Step the selection one place towards the front, or the back. Selected
   *  annotations keep their order relative to each other. */
  reorder(direction: 'forward' | 'backward' | 'front' | 'back'): boolean {
    if (!this.chosen.size || this.editing !== null) return false;
    const next = [...this.items];
    if (direction === 'front' || direction === 'back') {
      const picked = next.filter(item => this.chosen.has(item.id));
      const rest = next.filter(item => !this.chosen.has(item.id));
      if (!rest.length) return false;
      this.commitHistory();
      this.items = direction === 'front' ? [...rest, ...picked] : [...picked, ...rest];
    } else {
      // Swap past the nearest neighbour that is not itself selected, walking
      // from the edge we are moving towards so a run of items shuffles whole.
      let moved = false;
      if (direction === 'forward') {
        for (let i = next.length - 2; i >= 0; i--) {
          if (this.chosen.has(next[i].id) && !this.chosen.has(next[i + 1].id)) {
            [next[i], next[i + 1]] = [next[i + 1], next[i]]; moved = true;
          }
        }
      } else {
        for (let i = 1; i < next.length; i++) {
          if (this.chosen.has(next[i].id) && !this.chosen.has(next[i - 1].id)) {
            [next[i], next[i - 1]] = [next[i - 1], next[i]]; moved = true;
          }
        }
      }
      if (!moved) return false;
      this.commitHistory();
      this.items = next;
    }
    this.render(); this.onChange();
    return true;
  }

  get copied(): readonly Annotation[] { return this.clipboard; }

  /** Take the selection, if there is one. Returns what it took, for the caller
   *  to report. */
  copySelection(): Annotation[] {
    const picked = this.selection;
    if (!picked.length) return [];
    this.clipboard = picked.map(item => ({ ...item }));
    return this.clipboard;
  }

  /** Drop the held annotation onto the capture, offset from wherever it came
   *  from. Pasting again cascades, because the pasted copy becomes the one held. */
  paste(): Annotation[] {
    if (!this.clipboard.length) return [];
    this.commitHistory();
    const copies = this.clipboard.map(item =>
      ({ ...offsetBy(item, this.base * 0.9), id: this.nextId++ }));
    this.items.push(...copies);
    this.chosen = new Set(copies.map(copy => copy.id));
    this.clipboard = copies;
    // A redaction pasted somewhere else has to hide what is there now, not a
    // stale patch of wherever it was copied from.
    for (const copy of copies) {
      if (copy.kind === 'redact') { copy.pixels = undefined; this.settle(copy); }
    }
    this.render(); this.onChange();
    return copies;
  }

  duplicateSelection(): Annotation[] {
    return this.copySelection().length ? this.paste() : [];
  }

  /** Restyle the selection, or set the style for the next annotation. */
  applyStyle(): void {
    const picked = this.selection;
    if (picked.length) {
      this.commitHistory();
      for (const item of picked) {
        item.color = this.style.color;
        if (item.kind === 'text') item.size = textSize(this.weight);
        else item.weight = this.weight;
        // Coarseness follows the size control, so the patch must be rebuilt.
        this.settle(item);
      }
    }
    if (this.editing !== null) this.placeEditor();
    this.render(); this.onChange();
  }

  private at(event: PointerEvent | MouseEvent): Point {
    const rect = this.svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return [0, 0];
    return [((event.clientX - rect.left) / rect.width) * this.width,
            ((event.clientY - rect.top) / rect.height) * this.height];
  }

  private find(id: number | null): Annotation | undefined { return this.items.find(item => item.id === id); }

  private targetId(target: Element): number | null {
    const raw = target.closest?.('[data-item]')?.getAttribute('data-item');
    return raw === null || raw === undefined ? null : Number(raw);
  }

  // ---- text editing -------------------------------------------------------

  private edit(note: Note, fresh = false): void {
    this.editing = note.id;
    this.editingIsNew = fresh;
    this.chosen = new Set([note.id]);
    this.editor.hidden = false;
    this.editor.value = note.text;
    this.placeEditor();
    this.render();
    // The textarea appears directly under the pointer that opened it, so the
    // rest of that gesture -- the second click of a double-click, and the
    // word-selecting dblclick after it -- would land inside and drag the caret
    // off the end. Stay out of the pointer's way until the gesture is over.
    this.editor.style.pointerEvents = 'none';
    window.clearTimeout(this.gesture);
    this.gesture = window.setTimeout(() => { this.editor.style.pointerEvents = ''; }, 250);
    this.editor.focus();
    const end = this.editor.value.length;
    this.editor.setSelectionRange(end, end);
    this.onChange();
  }

  private placeEditor(): void {
    const note = this.find(this.editing);
    if (!note || note.kind !== 'text') return;
    const scale = this.scale;
    const style = this.editor.style;
    style.left = `${note.x * scale}px`;
    style.top = `${note.y * scale}px`;
    style.fontSize = `${note.size * scale}px`;
    style.color = note.color;
    this.fitEditor();
  }

  /** Grow the box with what is typed, so the caret is never off the edge. */
  private fitEditor(): void {
    const scale = this.scale;
    const note = this.find(this.editing);
    if (!note || note.kind !== 'text') return;
    const rows = this.editor.value.split('\n');
    const widest = rows.reduce((most, row) => Math.max(most, row.length), 1);
    this.editor.style.width = `${Math.max(2, widest + 1) * note.size * scale * 0.62}px`;
    this.editor.style.height = `${rows.length * note.size * scale * LINE}px`;
  }

  /** Leave editing, keeping what was typed. Empty text leaves nothing behind. */
  commit(): void {
    const note = this.find(this.editing);
    const wasNew = this.editingIsNew;
    this.editing = null;
    this.editingIsNew = false;
    window.clearTimeout(this.gesture);
    this.editor.style.pointerEvents = '';
    this.editor.hidden = true;
    if (!note || note.kind !== 'text') { this.render(); this.onChange(); return; }
    const text = this.editor.value.replace(/\s+$/, '');
    if (!text) {
      this.items = this.items.filter(item => item.id !== note.id);
      this.chosen.delete(note.id);
      // A box that never held anything leaves no trace, not even in undo. Text
      // cleared out of an existing note is a real edit and stays undoable.
      if (wasNew) this.past.pop();
    } else note.text = text;
    this.render(); this.onChange();
  }

  // ---- pointer ------------------------------------------------------------

  private down = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.width) return;
    event.preventDefault();
    if (this.editing !== null) { this.commit(); return; }
    this.svg.setPointerCapture(event.pointerId);
    const [x, y] = this.at(event);
    const target = event.target as Element;
    const end = target.getAttribute?.('data-handle');
    const hit = this.targetId(target);

    const corner = target.getAttribute?.('data-corner') as Corner | null;
    const cropCorner = target.getAttribute?.('data-crop') as Corner | null;
    const current = this.find(this.selected);

    if (this.tool === 'crop') {
      if (cropCorner && this.pendingCrop) {
        const from = this.pendingCrop;
        const anchorX = cropCorner === 'nw' || cropCorner === 'sw' ? from.x + from.width : from.x;
        const anchorY = cropCorner === 'nw' || cropCorner === 'ne' ? from.y + from.height : from.y;
        this.drag = { kind: 'crop', ox: anchorX, oy: anchorY };
      } else {
        this.drag = { kind: 'crop', ox: x, oy: y };
        this.pendingCrop = { x, y, width: 0, height: 0 };
      }
      this.chosen.clear();
      this.render(); this.onChange();
      return;
    }

    if (end && current?.kind === 'arrow') {
      this.commitHistory();
      this.drag = { kind: 'reshape', id: current.id, end: end === '1' ? 1 : 2 };
    } else if (corner && current && isShape(current)) {
      this.commitHistory();
      this.drag = { kind: 'corner', id: current.id, corner, from: { ...current } };
    } else if (hit !== null) {
      const from = this.find(hit);
      if (!from) return;
      // Shift adds to or removes from the selection, and never starts a drag:
      // extending a selection and moving it are different intentions.
      if (event.shiftKey) {
        this.svg.releasePointerCapture(event.pointerId);
        if (this.chosen.has(hit)) this.chosen.delete(hit); else this.chosen.add(hit);
        this.lastClick = null;
        this.render(); this.onChange();
        return;
      }
      const repeat = this.lastClick?.id === hit && performance.now() - this.lastClick.time < 450;
      this.commitHistory();
      if (repeat && from.kind === 'text' && this.chosen.size <= 1) {
        this.lastClick = null;
        this.svg.releasePointerCapture(event.pointerId);
        this.edit(from);
        return;
      }
      // Pressing inside an existing selection drags the whole of it; pressing
      // anything else selects just that.
      if (!this.chosen.has(hit)) this.chosen = new Set([hit]);
      this.drag = { kind: 'move', id: hit, ox: x, oy: y, from: this.selection.map(item => ({ ...item })) };
    } else if (this.tool === 'text') {
      this.commitHistory();
      const note: Note = { kind: 'text', id: this.nextId++, x, y, text: '', color: this.style.color, size: textSize(this.weight) };
      this.items.push(note);
      this.svg.releasePointerCapture(event.pointerId);
      this.edit(note, true);
      return;
    } else if (this.tool === 'arrow') {
      this.commitHistory();
      const arrow: Arrow = { kind: 'arrow', id: this.nextId++, x1: x, y1: y, x2: x, y2: y, color: this.style.color, weight: this.weight };
      this.items.push(arrow);
      this.chosen = new Set([arrow.id]);
      this.drag = { kind: 'create', id: arrow.id, ox: x, oy: y };
    } else {
      this.commitHistory();
      const shape: Shape = {
        kind: this.tool as ShapeKind, id: this.nextId++, x, y, width: 0, height: 0,
        color: this.style.color, weight: this.weight,
      };
      this.items.push(shape);
      this.chosen = new Set([shape.id]);
      this.drag = { kind: 'create', id: shape.id, ox: x, oy: y };
    }
    this.render(); this.onChange();
  };

  private move = (event: PointerEvent): void => {
    if (!this.drag) return;
    if (this.drag.kind === 'crop') {
      const [cx, cy] = this.at(event);
      this.pendingCrop = clampRect(span(this.drag.ox, this.drag.oy, cx, cy), this.width, this.height);
      this.render();
      return;
    }
    const item = this.find(this.drag.id);
    if (!item) return;
    const [x, y] = this.at(event);
    if (this.drag.kind === 'move') {
      const dx = x - this.drag.ox, dy = y - this.drag.oy;
      for (const from of this.drag.from) {
        const live = this.find(from.id);
        if (!live) continue;
        if (live.kind === 'arrow' && from.kind === 'arrow') {
          live.x1 = from.x1 + dx; live.y1 = from.y1 + dy;
          live.x2 = from.x2 + dx; live.y2 = from.y2 + dy;
        } else if (live.kind !== 'arrow' && from.kind !== 'arrow') {
          live.x = from.x + dx; live.y = from.y + dy;
        }
      }
    } else if (this.drag.kind === 'corner' && isShape(item)) {
      // Drag one corner and the opposite corner stays put.
      const { from, corner } = this.drag;
      const anchorX = corner === 'nw' || corner === 'sw' ? from.x + from.width : from.x;
      const anchorY = corner === 'nw' || corner === 'ne' ? from.y + from.height : from.y;
      Object.assign(item, span(anchorX, anchorY, x, y));
    } else if (item.kind === 'arrow') {
      if (this.drag.kind === 'create') { item.x2 = x; item.y2 = y; }
      else if (this.drag.kind === 'reshape') {
        if (this.drag.end === 1) { item.x1 = x; item.y1 = y; } else { item.x2 = x; item.y2 = y; }
      }
    } else if (this.drag.kind === 'create' && isShape(item)) {
      Object.assign(item, span(this.drag.ox, this.drag.oy, x, y));
    }
    this.render();
  };

  private up = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (this.svg.hasPointerCapture(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);
    if (drag.kind === 'crop') {
      const crop = this.pendingCrop;
      if (crop && (crop.width < MIN_CROP || crop.height < MIN_CROP)) this.pendingCrop = null;
      this.render(); this.onChange();
      return;
    }
    const item = this.find(drag.id);
    if (drag.kind === 'move') {
      const [x, y] = this.at(event);
      const shifted = Math.hypot(x - drag.ox, y - drag.oy) >= this.base * 0.5;
      this.lastClick = shifted ? null : { id: drag.id, time: performance.now() };
    } else this.lastClick = null;
    // A click rather than a drag leaves nothing behind but a cleared selection.
    const stillborn = drag.kind === 'create' && item !== undefined && (item.kind === 'arrow'
      ? Math.hypot(item.x2 - item.x1, item.y2 - item.y1) < this.base
      : isShape(item) && (item.width < this.base || item.height < this.base));
    if (stillborn && item) {
      this.items = this.items.filter(other => other.id !== item.id);
      this.chosen.clear();
      this.past.pop();
    } else if (drag.kind === 'move') drag.from.forEach(from => this.settle(this.find(from.id)));
    else this.settle(item);
    this.render(); this.onChange();
  };

  // ---- rendering ----------------------------------------------------------

  render(): void {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    for (const item of this.items) {
      if (item.id === this.editing) continue;   // the textarea stands in while editing
      if (item.kind === 'arrow') {
        const path = document.createElementNS(SVG, 'path');
        path.setAttribute('d', polygonPath(arrowPolygon(item)));
        path.setAttribute('fill', item.color);
        path.setAttribute('data-item', String(item.id));
        path.setAttribute('class', 'arrow');
        this.svg.append(path);
      } else if (isShape(item)) {
        this.svg.append(this.shapeNode(item));
      } else {
        const group = document.createElementNS(SVG, 'g');
        group.setAttribute('data-item', String(item.id));
        group.setAttribute('class', 'note');
        const text = document.createElementNS(SVG, 'text');
        text.setAttribute('x', String(item.x));
        text.setAttribute('y', String(item.y));
        text.setAttribute('fill', item.color);
        text.setAttribute('font-family', FONT);
        text.setAttribute('font-size', String(item.size));
        text.setAttribute('font-weight', String(WEIGHT));
        text.setAttribute('dominant-baseline', 'text-before-edge');
        text.setAttribute('xml:space', 'preserve');
        lines(item).forEach((line, i) => {
          const piece = document.createElementNS(SVG, 'tspan');
          piece.setAttribute('x', String(item.x));
          piece.setAttribute('dy', i ? String(item.size * LINE) : '0');
          piece.textContent = line || ' ';
          text.append(piece);
        });
        // Glyph outlines alone are a poor drag target, so a transparent box
        // sized from the rendered text takes the pointer instead.
        const box = document.createElementNS(SVG, 'rect');
        box.setAttribute('fill', 'transparent');
        group.append(box, text);
        this.svg.append(group);
        const bounds = text.getBBox();
        box.setAttribute('x', String(bounds.x)); box.setAttribute('y', String(bounds.y));
        box.setAttribute('width', String(bounds.width)); box.setAttribute('height', String(bounds.height));
        if (this.chosen.has(item.id)) group.append(this.dashedOutline(bounds, item.size * 0.16));
      }
    }
    if (this.pendingCrop) { this.renderCrop(this.pendingCrop); return; }
    // Handles belong to a single selection; several at once get outlines only,
    // because a handle would be ambiguous about which shape it resizes.
    for (const item of this.selection) {
      if (this.chosen.size > 1 && item.kind !== 'text') {
        this.svg.append(this.dashedOutline(bounds(item), this.base * 0.25));
      }
    }
    const chosen = this.find(this.selected);
    if (chosen?.kind === 'arrow') {
      this.svg.append(this.grip(chosen.x1, chosen.y1, 'data-handle', '1'),
                      this.grip(chosen.x2, chosen.y2, 'data-handle', '2'));
    } else if (chosen && isShape(chosen)) {
      this.svg.append(this.dashedOutline(chosen, 0));
      for (const corner of CORNERS) {
        this.svg.append(this.grip(
          chosen.x + (corner === 'ne' || corner === 'se' ? chosen.width : 0),
          chosen.y + (corner === 'sw' || corner === 'se' ? chosen.height : 0),
          'data-corner', corner));
      }
    }
  }

  /** Everything outside the crop is dimmed by one even-odd path: the capture's
   *  own rectangle with the crop punched out of it. */
  private renderCrop(crop: Rect): void {
    const veil = document.createElementNS(SVG, 'path');
    veil.setAttribute('d',
      `M0 0H${this.width}V${this.height}H0Z ` +
      `M${crop.x} ${crop.y}H${crop.x + crop.width}V${crop.y + crop.height}H${crop.x}Z`);
    veil.setAttribute('fill-rule', 'evenodd');
    veil.setAttribute('class', 'crop-veil');
    const frame = document.createElementNS(SVG, 'rect');
    frame.setAttribute('x', String(crop.x)); frame.setAttribute('y', String(crop.y));
    frame.setAttribute('width', String(Math.max(crop.width, 1)));
    frame.setAttribute('height', String(Math.max(crop.height, 1)));
    frame.setAttribute('class', 'crop-frame');
    frame.setAttribute('stroke-width', String(1.5 / this.scale));
    this.svg.append(veil, frame);
    for (const corner of CORNERS) {
      this.svg.append(this.grip(
        crop.x + (corner === 'ne' || corner === 'se' ? crop.width : 0),
        crop.y + (corner === 'sw' || corner === 'se' ? crop.height : 0),
        'data-crop', corner));
    }
  }

  private grip(cx: number, cy: number, attribute: string, value: string): SVGElement {
    const handle = document.createElementNS(SVG, 'circle');
    handle.setAttribute('cx', String(cx));
    handle.setAttribute('cy', String(cy));
    handle.setAttribute('r', String(this.handleRadius));
    handle.setAttribute(attribute, value);
    handle.setAttribute('class', 'handle');
    handle.setAttribute('stroke-width', String(this.handleRadius * 0.34));
    return handle;
  }

  private dashedOutline(bounds: { x: number; y: number; width: number; height: number }, pad: number): SVGElement {
    const outline = document.createElementNS(SVG, 'rect');
    outline.setAttribute('x', String(bounds.x - pad)); outline.setAttribute('y', String(bounds.y - pad));
    outline.setAttribute('width', String(Math.max(bounds.width + pad * 2, 1)));
    outline.setAttribute('height', String(Math.max(bounds.height + pad * 2, 1)));
    outline.setAttribute('class', 'note-outline');
    outline.setAttribute('stroke-width', String(1.5 / this.scale));
    outline.setAttribute('stroke-dasharray', `${4 / this.scale} ${3 / this.scale}`);
    return outline;
  }

  private shapeNode(item: Shape): SVGElement {
    const group = document.createElementNS(SVG, 'g');
    group.setAttribute('data-item', String(item.id));
    group.setAttribute('class', 'shape');
    const { x, y, width, height } = item;
    const size = (node: SVGElement) => {
      if (item.kind === 'ellipse') {
        node.setAttribute('cx', String(x + width / 2)); node.setAttribute('cy', String(y + height / 2));
        node.setAttribute('rx', String(Math.max(width / 2 - item.weight / 2, 0.5)));
        node.setAttribute('ry', String(Math.max(height / 2 - item.weight / 2, 0.5)));
      } else {
        node.setAttribute('x', String(x + item.weight / 2)); node.setAttribute('y', String(y + item.weight / 2));
        node.setAttribute('width', String(Math.max(width - item.weight, 1)));
        node.setAttribute('height', String(Math.max(height - item.weight, 1)));
      }
      return node;
    };
    const cover = (node: SVGElement) => {
      node.setAttribute('x', String(x)); node.setAttribute('y', String(y));
      node.setAttribute('width', String(Math.max(width, 1)));
      node.setAttribute('height', String(Math.max(height, 1)));
      return node;
    };

    if (item.kind === 'redact') {
      if (item.pixels) {
        const patch = cover(document.createElementNS(SVG, 'image'));
        patch.setAttribute('href', item.pixels);
        patch.setAttribute('preserveAspectRatio', 'none');
        group.append(patch);
      } else {
        // While the region is still moving, cover it outright. A redaction that
        // flickers see-through is worse than a plain block.
        const block = cover(document.createElementNS(SVG, 'rect'));
        block.setAttribute('class', 'redact-pending');
        group.append(block);
      }
      return group;
    }

    if (item.kind === 'highlight') {
      const ink = cover(document.createElementNS(SVG, 'rect'));
      ink.setAttribute('fill', item.color);
      ink.setAttribute('class', 'highlight');
      group.append(ink);
      return group;
    }

    const tag = item.kind === 'ellipse' ? 'ellipse' : 'rect';
    // An outline is a thin target, so an invisible fat stroke takes the pointer.
    const grab = size(document.createElementNS(SVG, tag));
    grab.setAttribute('fill', 'none');
    grab.setAttribute('stroke', 'transparent');
    grab.setAttribute('stroke-width', String(Math.max(item.weight, 16 / this.scale)));
    const line = size(document.createElementNS(SVG, tag));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', item.color);
    line.setAttribute('stroke-width', String(item.weight));
    group.append(grab, line);
    return group;
  }
}
