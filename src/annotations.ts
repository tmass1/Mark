/** Arrow annotations drawn over a capture.
 *
 *  Every coordinate is in image-pixel space, never screen space. The overlay is
 *  an SVG whose viewBox matches the capture's natural size, so a drawing keeps
 *  its position when the window resizes and composites at full resolution.
 */

export interface Arrow { id: number; x1: number; y1: number; x2: number; y2: number; color: string; weight: number }
export type Point = [number, number];

const SVG = 'http://www.w3.org/2000/svg';

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

/** Paint onto a 2D context at natural size. Shared by export so the copied PNG
 *  matches the screen exactly. */
export function drawArrows(ctx: CanvasRenderingContext2D, arrows: readonly Arrow[]): void {
  for (const arrow of arrows) {
    const points = arrowPolygon(arrow);
    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = arrow.color;
    ctx.fill();
  }
}

type Drag =
  | { kind: 'create'; id: number }
  | { kind: 'move'; id: number; ox: number; oy: number; from: Arrow }
  | { kind: 'reshape'; id: number; end: 1 | 2 };

export interface LayerStyle { color: string; scale: number }

export class ArrowLayer {
  private items: Arrow[] = [];
  private past: Arrow[][] = [];
  private nextId = 1;
  private drag: Drag | null = null;
  private width = 0;
  private height = 0;
  private handleRadius = 6;
  selected: number | null = null;
  base = 12;
  style: LayerStyle = { color: COLORS[0].value, scale: 1 };

  constructor(private svg: SVGSVGElement, private onChange: () => void) {
    svg.addEventListener('pointerdown', this.down);
    svg.addEventListener('pointermove', this.move);
    svg.addEventListener('pointerup', this.up);
    svg.addEventListener('pointercancel', this.up);
  }

  get arrows(): readonly Arrow[] { return this.items; }
  get empty(): boolean { return this.items.length === 0; }
  get canUndo(): boolean { return this.past.length > 0; }
  private get weight(): number { return this.base * this.style.scale; }

  /** Point to the new capture. Drawings never carry across captures. */
  setImage(width: number, height: number): void {
    this.width = width; this.height = height;
    this.base = baseWeight(width, height);
    this.items = []; this.past = []; this.selected = null; this.drag = null;
    this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this.measure(); this.render();
  }

  /** Handles are specified on screen and converted back, so they stay grabbable
   *  whether the capture is 200px or 6000px wide. */
  measure(): void {
    const shown = this.svg.getBoundingClientRect().width;
    this.handleRadius = shown > 0 && this.width > 0 ? (7 * this.width) / shown : 7;
    if (this.selected !== null) this.render();
  }

  private commit(): void { this.past.push(this.items.map(a => ({ ...a }))); if (this.past.length > 60) this.past.shift(); }

  undo(): boolean {
    const previous = this.past.pop();
    if (!previous) return false;
    this.items = previous;
    if (!this.items.some(a => a.id === this.selected)) this.selected = null;
    this.render(); this.onChange();
    return true;
  }

  deleteSelected(): boolean {
    if (this.selected === null) return false;
    this.commit();
    this.items = this.items.filter(a => a.id !== this.selected);
    this.selected = null;
    this.render(); this.onChange();
    return true;
  }

  deselect(): boolean {
    if (this.selected === null) return false;
    this.selected = null; this.render(); this.onChange();
    return true;
  }

  /** Restyle the selected arrow, or set the style for the next one. */
  applyStyle(): void {
    const arrow = this.items.find(a => a.id === this.selected);
    if (arrow) {
      this.commit();
      arrow.color = this.style.color; arrow.weight = this.weight;
    }
    this.render(); this.onChange();
  }

  private at(event: PointerEvent): Point {
    const rect = this.svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return [0, 0];
    return [((event.clientX - rect.left) / rect.width) * this.width,
            ((event.clientY - rect.top) / rect.height) * this.height];
  }

  private find(id: number | null): Arrow | undefined { return this.items.find(a => a.id === id); }

  private down = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.width) return;
    event.preventDefault();
    this.svg.setPointerCapture(event.pointerId);
    const [x, y] = this.at(event);
    const target = event.target as Element;
    const end = target.getAttribute?.('data-handle');
    const onArrow = Number(target.getAttribute?.('data-arrow') ?? NaN);

    if (end && this.selected !== null) {
      this.commit();
      this.drag = { kind: 'reshape', id: this.selected, end: end === '1' ? 1 : 2 };
    } else if (Number.isFinite(onArrow)) {
      const from = this.find(onArrow);
      if (!from) return;
      this.commit();
      this.selected = onArrow;
      this.drag = { kind: 'move', id: onArrow, ox: x, oy: y, from: { ...from } };
    } else {
      this.commit();
      const arrow: Arrow = { id: this.nextId++, x1: x, y1: y, x2: x, y2: y, color: this.style.color, weight: this.weight };
      this.items.push(arrow);
      this.selected = arrow.id;
      this.drag = { kind: 'create', id: arrow.id };
    }
    this.render(); this.onChange();
  };

  private move = (event: PointerEvent): void => {
    if (!this.drag) return;
    const arrow = this.find(this.drag.id);
    if (!arrow) return;
    const [x, y] = this.at(event);
    if (this.drag.kind === 'create') { arrow.x2 = x; arrow.y2 = y; }
    else if (this.drag.kind === 'reshape') {
      if (this.drag.end === 1) { arrow.x1 = x; arrow.y1 = y; } else { arrow.x2 = x; arrow.y2 = y; }
    } else {
      const dx = x - this.drag.ox, dy = y - this.drag.oy, from = this.drag.from;
      arrow.x1 = from.x1 + dx; arrow.y1 = from.y1 + dy;
      arrow.x2 = from.x2 + dx; arrow.y2 = from.y2 + dy;
    }
    this.render();
  };

  private up = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (this.svg.hasPointerCapture(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);
    const arrow = this.find(drag.id);
    // A click rather than a drag: drop the stillborn arrow and clear the selection.
    if (drag.kind === 'create' && arrow && Math.hypot(arrow.x2 - arrow.x1, arrow.y2 - arrow.y1) < this.base) {
      this.items = this.items.filter(a => a.id !== arrow.id);
      this.selected = null;
      this.past.pop();
    }
    this.render(); this.onChange();
  };

  render(): void {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    for (const arrow of this.items) {
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', polygonPath(arrowPolygon(arrow)));
      path.setAttribute('fill', arrow.color);
      path.setAttribute('data-arrow', String(arrow.id));
      path.setAttribute('class', arrow.id === this.selected ? 'arrow selected' : 'arrow');
      this.svg.append(path);
    }
    const chosen = this.find(this.selected);
    if (!chosen) return;
    for (const end of [1, 2] as const) {
      const handle = document.createElementNS(SVG, 'circle');
      handle.setAttribute('cx', String(end === 1 ? chosen.x1 : chosen.x2));
      handle.setAttribute('cy', String(end === 1 ? chosen.y1 : chosen.y2));
      handle.setAttribute('r', String(this.handleRadius));
      handle.setAttribute('data-handle', String(end));
      handle.setAttribute('class', 'handle');
      handle.setAttribute('stroke-width', String(this.handleRadius * 0.34));
      this.svg.append(handle);
    }
  }
}
