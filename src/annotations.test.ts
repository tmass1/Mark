import { describe, expect, it } from 'vitest';
import {
  HIGHLIGHT_ALPHA, SHAPES, arrowPolygon, baseWeight, blockSize, drawAnnotations, isShape, lines,
  ARROW_STYLES, COLORS, arrowPaint, arrowStrokeWidth, arrowStrokes, badgeAt, describe as describeKind, inkOn, isSegment, numbered,
  noteAt, offsetBy, penPath, polygonPath, stepArrow, stepList, stepNumbers, stepRadius, styleOf, textSize, thin,
  type Arrow, type Note, type Point, type Shape, type Step,
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
const step = (over: Partial<Step> = {}): Step =>
  ({ kind: 'step', id: 4, x: 100, y: 100, color: '#ff3b30', weight: 10, ...over });

/** Records the calls drawAnnotations makes, so export can be checked without a
 *  canvas. The size stands in for the capture's, which is what a badge is
 *  clamped into. */
function recorder(width = 1200, height = 740) {
  const calls: string[] = [];
  const ctx = {
    canvas: { width, height },
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
    fillText: (text: string, x: number, y: number) => calls.push(`text!:${text}@${x},${y}`),
    arc: (x: number, y: number, r: number) => calls.push(`arc:${x},${y},${r}`),
    textAlign: '', drawImage: () => calls.push('image'),
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

describe('arrow styles', () => {
  it('treats an arrow without a style as tapered, so older ones are unchanged', () => {
    expect(styleOf(arrow())).toBe('taper');
    expect(styleOf(arrow({ style: 'straight' }))).toBe('straight');
  });

  it('tapers almost to a point at the tail, and holds width when straight', () => {
    const tapered = arrowPolygon(arrow({ style: 'taper', weight: 10 }));
    const straight = arrowPolygon(arrow({ style: 'straight', weight: 10 }));
    expect(tapered[0][1]).toBeCloseTo(1.6);        // a sixth of the shaft
    expect(straight[0][1]).toBeCloseTo(4.4);       // the same as the shaft
    expect(straight[0][1]).toBeCloseTo(straight[1][1]);
  });

  it('lands every style head exactly where the pointer was released', () => {
    for (const style of ARROW_STYLES) {
      const a = arrow({ style, x2: 240, y2: 120 });
      const tip = style === 'line' ? arrowStrokes(a)[0][1] : arrowPolygon(a)[3];
      expect(tip).toEqual([240, 120]);
    }
  });

  it('draws the thin style as a shaft and two wings meeting at the tip', () => {
    const runs = arrowStrokes(arrow({ style: 'line' }));
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual([[0, 0], [100, 0]]);   // the shaft, end to end
    expect(runs[1][1]).toEqual([100, 0]);          // wings meet at the tip
    // Symmetric about the shaft.
    expect(runs[1][0][1]).toBeCloseTo(-runs[1][2][1]);
  });

  it('strokes the thin style instead of filling it', () => {
    const { ctx, calls } = recorder();
    drawAnnotations(ctx, [arrow({ style: 'line', color: '#34c759' })]);
    expect(calls).toContain('stroke:#34c759');
    expect(calls).toContain('stroke!');
    expect(calls).not.toContain('shape');          // no filled polygon
  });

  it('keeps the wings inside a very short arrow', () => {
    const runs = arrowStrokes(arrow({ style: 'line', x2: 8, weight: 20 }));
    for (const [x] of runs[1]) expect(x).toBeGreaterThanOrEqual(-1);
  });
});


/** WCAG contrast, so the test checks the rule rather than restating the answer. */
function contrastBetween(a: string, b: string): number {
  const lum = (color: string) => {
    const hex = color.replace('#', '');
    const channel = (at: number) => {
      const value = parseInt(hex.slice(at, at + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('numbered steps', () => {
  it('numbers the badges by the order they were drawn, and only the badges', () => {
    const items = [step({ id: 7 }), arrow(), step({ id: 9 }), note(), step({ id: 3 })];
    expect([...stepNumbers(items)]).toEqual([[7, 1], [9, 2], [3, 3]]);
  });

  it('closes the gap when one is deleted, so the sequence is always contiguous', () => {
    const items = [step({ id: 7 }), step({ id: 9 }), step({ id: 3 })];
    const left = items.filter(item => item.id !== 9);
    expect([...stepNumbers(left)].map(([, n]) => n)).toEqual([1, 2]);
    // And a pasted copy -- which the layer gives an id of its own -- takes the
    // next number rather than repeating one.
    const pasted = [...left, { ...offsetBy(left[0], 20), id: 42 }];
    expect([...stepNumbers(pasted)]).toEqual([[7, 1], [3, 2], [42, 3]]);
  });

  it('starts the arrow clear of the badge and lands the head where the pointer was released', () => {
    const arrowOf = stepArrow(step({ to: [300, 100] }))!;
    expect(arrowOf).not.toBeNull();
    expect([arrowOf.x2, arrowOf.y2]).toEqual([300, 100]);
    // The tail sits outside the disc, so the badge stays a disc.
    expect(arrowOf.x1).toBeGreaterThan(100 + stepRadius(10));
    expect(arrowPolygon(arrowOf)[3]).toEqual([300, 100]);
  });

  it('points with whichever arrow style it was given, stroked or filled', () => {
    // The step's arrow used to be hardcoded solid, so a thin one came out filled.
    expect(arrowPaint(stepArrow(step({ to: [300, 100], style: 'line' }))!).stroked).toBe(true);
    for (const style of ['taper', 'straight'] as const) {
      expect(arrowPaint(stepArrow(step({ to: [300, 100], style }))!).stroked).toBe(false);
    }
    const { ctx, calls } = recorder();
    drawAnnotations(ctx, [step({ to: [300, 100], style: 'line' })]);
    expect(calls).toContain('stroke!');
    expect(calls).toContain(`width:${arrowStrokeWidth(10 * 0.72)}`);
  });

  it('draws no arrow for a badge that was clicked, or dragged barely at all', () => {
    expect(stepArrow(step())).toBeNull();
    expect(stepArrow(step({ to: [104, 103] }))).toBeNull();
  });

  it('carries the arrow head when a copy is offset', () => {
    const moved = offsetBy(step({ to: [300, 100] }), 20);
    expect([moved.x, moved.y]).toEqual([120, 120]);
    expect(moved.to).toEqual([320, 120]);
    expect(offsetBy(step(), 20).to).toBeUndefined();
  });

  it('picks the numeral ink that carries on each swatch', () => {
    // A white numeral on Mark's white or yellow is no numeral at all, and on
    // its orange and green it falls under the 3:1 a large glyph needs.
    const ink = Object.fromEntries(COLORS.map(c => [c.name, inkOn(c.value)]));
    for (const name of ['White', 'Yellow', 'Orange', 'Green']) expect(ink[name]).toBe('#1c1c1e');
    for (const name of ['Red', 'Blue', 'Purple', 'Black']) expect(ink[name]).toBe('#ffffff');
    // Every swatch clears the bar one way or the other, which is the point.
    for (const { value } of COLORS) {
      const chosen = inkOn(value) === '#ffffff' ? '#ffffff' : '#1c1c1e';
      expect(contrastBetween(value, chosen)).toBeGreaterThanOrEqual(3);
    }
  });

  it('exports the disc, the numeral and the arrow, with the numeral drawn last', () => {
    const { ctx, calls } = recorder();
    drawAnnotations(ctx, [step({ to: [300, 100] }), step({ id: 5, x: 50, y: 50 })]);
    expect(calls).toContain('arc:100,100,14.5');
    expect(calls).toContain('text!:1@100,100');
    expect(calls).toContain('text!:2@50,50');
    // The numeral is painted over its own disc, not under it.
    expect(calls.indexOf('arc:100,100,14.5')).toBeLessThan(calls.indexOf('text!:1@100,100'));
    // And the arrow goes down before the badge, so the disc covers the tail.
    expect(calls.filter(call => call === 'fill!').length).toBeGreaterThanOrEqual(3);
  });
});


describe('one sequence over circles and badges', () => {
  it('numbers steps and numbered shapes together, in the order drawn', () => {
    const items = [
      shape({ id: 1, kind: 'ellipse', numbered: true }),
      shape({ id: 2, kind: 'box' }),                       // not numbered: not in the run
      step({ id: 3 }),
      arrow(),
      shape({ id: 5, kind: 'ellipse', numbered: true }),
    ];
    expect(numbered(items).map(item => item.id)).toEqual([1, 3, 5]);
    expect([...stepNumbers(items)]).toEqual([[1, 1], [3, 2], [5, 3]]);
  });

  it('puts a shape’s badge outside its corner, and keeps it inside the image', () => {
    const r = stepRadius(8);
    const [x, y] = badgeAt(shape({ x: 300, y: 200, weight: 8, numbered: true }), 1200, 740);
    expect(x).toBeLessThan(300);                            // clear of the outline, not on it
    expect(y).toBeLessThan(200);
    // A circle drawn hard against the corner still shows its whole badge.
    const [cx, cy] = badgeAt(shape({ x: 0, y: 0, weight: 8, numbered: true }), 1200, 740);
    expect(cx).toBeGreaterThanOrEqual(r);
    expect(cy).toBeGreaterThanOrEqual(r);
  });

  it('exports a numbered circle’s badge, and never its note', () => {
    const { ctx, calls } = recorder();
    drawAnnotations(ctx, [shape({ id: 1, kind: 'ellipse', numbered: true, note: 'do not draw me' })]);
    expect(calls.some(call => call.startsWith('arc:'))).toBe(true);
    expect(calls).toContain('text!:1@' + badgeAt(shape({ kind: 'ellipse', numbered: true }), 1200, 740).join(','));
    expect(calls.join(' ')).not.toContain('do not draw me');
  });

  it('writes the list one line per mark, and a bare number where nothing was typed', () => {
    const items = [
      shape({ id: 1, kind: 'ellipse', numbered: true, note: 'make the nav sticky' }),
      step({ id: 2 }),
      shape({ id: 3, kind: 'box', numbered: true, note: 'remove this' }),
    ];
    expect(stepList(items)).toBe('1. make the nav sticky\n2.\n3. remove this');
    expect(stepList([arrow(), note()])).toBe('');
  });
});

describe('notes written on the image', () => {
  it('sits the note beside its badge, and flips to the other side at the edge', () => {
    const near = noteAt(step({ x: 100, y: 200, note: 'make the nav sticky' }), 1200, 740)!;
    expect(near.anchor).toBe('start');
    expect(near.x).toBeGreaterThan(100 + stepRadius(10));   // clear of the disc
    expect(near.y).toBe(200);                               // level with it
    expect(near.size).toBe(textSize(10));                   // the Text tool's own size

    const edge = noteAt(step({ x: 1150, y: 200, note: 'make the nav sticky' }), 1200, 740)!;
    expect(edge.anchor).toBe('end');
    expect(edge.x).toBeLessThan(1150);
  });

  it('has nothing to write for a mark with no note, or only spaces', () => {
    expect(noteAt(step(), 1200, 740)).toBeNull();
    expect(noteAt(step({ note: '   ' }), 1200, 740)).toBeNull();
  });

  it('writes the note only when asked, and the number either way', () => {
    const quiet = recorder();
    drawAnnotations(quiet.ctx, [step({ note: 'say this' })]);
    expect(quiet.calls).toContain('text!:1@100,100');
    expect(quiet.calls.join(' ')).not.toContain('say this');

    const loud = recorder();
    drawAnnotations(loud.ctx, [step({ note: 'say this' })], undefined, true);
    expect(loud.calls).toContain('text!:1@100,100');
    expect(loud.calls.some(call => call.startsWith('text!:say this@'))).toBe(true);
  });
});
