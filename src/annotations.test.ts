import { describe, expect, it } from 'vitest';
import {
  HIGHLIGHT_ALPHA, SHAPES, arrowPolygon, baseWeight, blockSize, drawAnnotations, isShape, lines,
  describe as describeKind, isSegment, offsetBy, penPath, polygonPath, textSize, thin,
  type Arrow, type Note, type Point, type Shape,
} from './annotations';

const arrow = (over: Partial<Arrow> = {}): Arrow =>
  ({ kind: 'arrow', id: 1, x1: 0, y1: 0, x2: 100, y2: 0, color: '#ff3b30', weight: 10, ...over });
const note = (over: Partial<Note> = {}): Note =>
  ({ kind: 'text', id: 2, x: 40, y: 60, text: 'Look here', color: '#007aff', size: 30, ...over });

describe('arrow geometry', () => {
  it('puts the head exactly where the pointer was released', () => {
    for (const [x2, y2] of [[100, 0], [-40, 90], [0, -12], [33.5, 33.5]]) {
      expect(arrowPolygon(arrow({ x2, y2 }))[3]).toEqual([x2, y2]);
    }
  });

  it('tapers from a near-point tail to a wide head', () => {
    const [tail, shaft, head] = arrowPolygon(arrow());
    expect(tail[1]).toBeCloseTo(1.6);   // tail half-width
    expect(shaft[1]).toBeCloseTo(5);    // shaft where the head begins
    expect(head[1]).toBeCloseTo(15);    // head half-width
    expect(head[0]).toBeCloseTo(68);    // head is weight * 3.2 long
  });

  it('scales with weight, so the size control changes the whole arrow', () => {
    const thin = arrowPolygon(arrow({ weight: 5 }))[2];
    const thick = arrowPolygon(arrow({ weight: 20 }))[2];
    expect(thick[1]).toBeCloseTo(thin[1] * 4);
  });

  it('shortens the head on a stubby arrow instead of overrunning the tail', () => {
    const points = arrowPolygon(arrow({ x2: 20 }));
    expect(points[2][0]).toBeCloseTo(11.2);          // 20 - 20 * 0.44
    expect(points[2][0]).toBeGreaterThan(points[0][0]); // head never passes the tail
  });

  it('stays symmetric about the axis', () => {
    const points = arrowPolygon(arrow({ x2: 60, y2: 80 }));
    for (const [a, b] of [[0, 6], [1, 5], [2, 4]] as const) {
      expect(Math.hypot(points[a][0] - points[3][0], points[a][1] - points[3][1]))
        .toBeCloseTo(Math.hypot(points[b][0] - points[3][0], points[b][1] - points[3][1]));
    }
  });

  it('closes the path so the fill cannot leak', () => {
    const path = polygonPath(arrowPolygon(arrow()));
    expect(path.startsWith('M')).toBe(true);
    expect(path.endsWith('Z')).toBe(true);
    expect(path.match(/L/g)).toHaveLength(6);
  });
});

describe('default weight', () => {
  it('follows the capture size so arrows read the same at any resolution', () => {
    expect(baseWeight(1600, 1200)).toBeCloseTo(22, 0);
    expect(baseWeight(3200, 2400)).toBeCloseTo(44, 0);
  });
  it('clamps so tiny and enormous captures stay usable', () => {
    expect(baseWeight(60, 40)).toBe(5);
    expect(baseWeight(12000, 12000)).toBe(64);
  });
});

describe('text notes', () => {
  it('splits on newlines so each line is drawn separately', () => {
    expect(lines(note({ text: 'one\ntwo\nthree' }))).toEqual(['one', 'two', 'three']);
    expect(lines(note({ text: 'one' }))).toEqual(['one']);
  });

  it('sizes text off the same base as arrows, so one slider drives both', () => {
    expect(textSize(baseWeight(1600, 1200))).toBeCloseTo(baseWeight(1600, 1200) * 2);
  });

  it('paints arrows and text in the order they were added', () => {
    const calls: string[] = [];
    const ctx = {
      set fillStyle(value: string) { calls.push(`fill:${value}`); },
      set font(value: string) { calls.push(`font:${value}`); },
      textBaseline: '',
      beginPath: () => calls.push('begin'), closePath: () => calls.push('close'),
      moveTo: () => {}, lineTo: () => {}, fill: () => calls.push('shape'),
      fillText: (text: string, x: number, y: number) => calls.push(`text:${text}@${x},${y}`),
    } as unknown as CanvasRenderingContext2D;
    drawAnnotations(ctx, [arrow(), note({ text: 'a\nb', size: 20, x: 5, y: 7 })]);
    expect(calls).toContain('fill:#ff3b30');
    expect(calls).toContain('shape');
    // Second line sits one line-height below the first.
    expect(calls).toContain('text:a@5,7');
    expect(calls).toContain('text:b@5,32');
  });
});

const shape = (over: Partial<Shape> = {}): Shape =>
  ({ kind: 'box', id: 3, x: 10, y: 20, width: 200, height: 100, color: '#34c759', weight: 8, ...over });

/** Records the calls drawAnnotations makes, so export can be checked without a canvas. */
function recorder() {
  const calls: string[] = [];
  const ctx = {
    set fillStyle(v: string) { calls.push(`fill:${v}`); },
    set strokeStyle(v: string) { calls.push(`stroke:${v}`); },
    set lineWidth(v: number) { calls.push(`width:${v}`); },
    set globalAlpha(v: number) { calls.push(`alpha:${v}`); },
    set globalCompositeOperation(v: string) { calls.push(`blend:${v}`); },
    set font(v: string) { calls.push(`font:${v}`); },
    textBaseline: '', imageSmoothingEnabled: true,
    save: () => calls.push('save'), restore: () => calls.push('restore'),
    beginPath: () => calls.push('begin'), closePath: () => {}, stroke: () => calls.push('stroke!'),
    fill: () => calls.push('fill!'), moveTo: () => {}, lineTo: () => {},
    fillRect: (x: number, y: number, w: number, h: number) => calls.push(`rect!:${x},${y},${w},${h}`),
    rect: (x: number, y: number, w: number, h: number) => calls.push(`path:${x},${y},${w},${h}`),
    ellipse: (x: number, y: number, rx: number, ry: number) => calls.push(`oval:${x},${y},${rx},${ry}`),
    fillText: () => {}, drawImage: () => calls.push('image'),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe('shapes', () => {
  it('recognises which kinds are rectangles', () => {
    for (const kind of SHAPES) expect(isShape(shape({ kind }))).toBe(true);
    expect(isShape(arrow())).toBe(false);
    expect(isShape(note())).toBe(false);
  });

  it('insets a box by half its stroke so the outline lands inside the region', () => {
    const { ctx, calls } = recorder();
    drawAnnotations(ctx, [shape({ weight: 8 })]);
    expect(calls).toContain('path:14,24,192,92');   // 10+4, 20+4, 200-8, 100-8
    expect(calls).toContain('stroke!');
  });

  it('draws an ellipse centred in its region', () => {
    const { ctx, calls } = recorder();
    drawAnnotations(ctx, [shape({ kind: 'ellipse', weight: 8 })]);
    expect(calls).toContain('oval:110,70,96,46');   // centre 10+100, 20+50; radii inset by weight/2
  });

  it('lays highlighter ink as translucent multiply, then puts the context back', () => {
    const { ctx, calls } = recorder();
    drawAnnotations(ctx, [shape({ kind: 'highlight' }), shape({ kind: 'box' })]);
    expect(calls).toContain(`alpha:${HIGHLIGHT_ALPHA}`);
    expect(calls).toContain('blend:multiply');
    expect(calls).toContain('rect!:10,20,200,100');
    // save/restore bracket the blend so the box after it is unaffected.
    expect(calls.indexOf('save')).toBeLessThan(calls.indexOf('blend:multiply'));
    expect(calls.indexOf('restore')).toBeLessThan(calls.indexOf('stroke!'));
  });

  it('never strokes a shape with a negative size', () => {
    const { ctx, calls } = recorder();
    drawAnnotations(ctx, [shape({ width: 2, height: 2, weight: 20 })]);
    const path = calls.find(call => call.startsWith('path:'))!.slice(5).split(',').map(Number);
    expect(path[2]).toBeGreaterThan(0);
    expect(path[3]).toBeGreaterThan(0);
  });

  it('skips redaction rather than drawing a hole when the capture is missing', () => {
    const { ctx, calls } = recorder();
    drawAnnotations(ctx, [shape({ kind: 'redact' })]);
    expect(calls).not.toContain('image');
    expect(calls).not.toContain('stroke!');
  });
});

describe('redaction coarseness', () => {
  it('follows the size control', () => {
    expect(blockSize(20)).toBe(30);
    expect(blockSize(40)).toBe(60);
  });
  it('has a floor, so a small size cannot leave text readable', () => {
    expect(blockSize(1)).toBe(7);
    expect(blockSize(0)).toBe(7);
  });
});

describe('copying an annotation', () => {
  it('shifts a copy off its original so the two can be told apart', () => {
    const moved = offsetBy(arrow({ x1: 0, y1: 0, x2: 100, y2: 50 }), 10);
    expect([moved.x1, moved.y1, moved.x2, moved.y2]).toEqual([10, 10, 110, 60]);
    const shifted = offsetBy(shape({ x: 10, y: 20 }), 10);
    expect([shifted.x, shifted.y]).toEqual([20, 30]);
    expect(offsetBy(note({ x: 40, y: 60 }), 5)).toMatchObject({ x: 45, y: 65 });
  });

  it('leaves the original untouched', () => {
    const original = arrow({ x1: 0, y1: 0 });
    offsetBy(original, 25);
    expect([original.x1, original.y1]).toEqual([0, 0]);
  });

  it('names each kind for the status line', () => {
    expect(describeKind('arrow')).toBe('Arrow');
    expect(describeKind('text')).toBe('Text');
    expect(describeKind('redact')).toBe('Redaction');
    expect(describeKind('ellipse')).toBe('Ellipse');
  });
});

describe('freehand strokes', () => {
  const points: Point[] = [[0, 0], [10, 0], [20, 10], [30, 10]];

  it('curves through the midpoints rather than joining the samples straight', () => {
    const d = penPath(points);
    expect(d.startsWith('M0.00 0.00')).toBe(true);
    expect(d).toContain('Q');                    // smoothed, not a polyline
    expect(d.endsWith('L30.00 10.00')).toBe(true);
  });

  it('still draws something for a single tap', () => {
    expect(penPath([[5, 5]])).toBe('M5.00 5.00l0.01 0');
    expect(penPath([])).toBe('');
  });

  it('thins samples the pointer reported too close together', () => {
    const dense: Point[] = [[0, 0], [1, 0], [2, 0], [3, 0], [40, 0]];
    const kept = thin(dense, 10);
    expect(kept[0]).toEqual([0, 0]);
    expect(kept.at(-1)).toEqual([40, 0]);        // the end is never dropped
    expect(kept.length).toBeLessThan(dense.length);
  });

  it('keeps a stroke that is all one place from collapsing to nothing', () => {
    expect(thin([[7, 7]], 10)).toEqual([[7, 7]]);
  });

  it('offsets every point together', () => {
    const moved = offsetBy({ kind: 'pen', id: 1, points, color: '#000', weight: 8 } as never, 5) as
      { points: Point[] };
    expect(moved.points).toEqual([[5, 5], [15, 5], [25, 15], [35, 15]]);
  });
});

describe('lines', () => {
  const line = (over = {}) =>
    ({ kind: 'line', id: 9, x1: 0, y1: 0, x2: 100, y2: 50, color: '#007aff', weight: 12, ...over }) as const;

  it('counts as a segment, so it moves and reshapes like an arrow', () => {
    expect(isSegment(line() as never)).toBe(true);
    expect(isSegment(arrow())).toBe(true);
    expect(isSegment(note())).toBe(false);
    expect(isSegment(shape())).toBe(false);
  });

  it('is stroked end to end with no head, unlike an arrow', () => {
    const { ctx, calls } = recorder();
    drawAnnotations(ctx, [line() as never]);
    expect(calls).toContain('stroke:#007aff');
    expect(calls).toContain('width:12');
    expect(calls).toContain('stroke!');
    expect(calls).not.toContain('shape');        // no filled polygon: no arrowhead
  });

  it('offsets both ends together', () => {
    const moved = offsetBy(line() as never, 10) as ReturnType<typeof line>;
    expect([moved.x1, moved.y1, moved.x2, moved.y2]).toEqual([10, 10, 110, 60]);
  });
});
