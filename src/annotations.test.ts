import { describe, expect, it } from 'vitest';
import {
  HIGHLIGHT_ALPHA, SHAPES, arrowPolygon, baseWeight, blockSize, drawAnnotations, isShape, lines,
  ARROW_STYLES, COLORS, arrowPaint, arrowStrokeWidth, arrowStrokes, badgeAt, describe as describeKind, inkOn, isSegment, numbered,
  noteAt, offsetBy, penPath, polygonPath, snapAngle, stepArrow, stepList, stepNumbers, stepRadius, styleOf,
  textSize, thin, borderColor, borderWidth, markShadow, outsetOps, pathData, pillAt, pillExit, restyled,
  shadowReach, stepTextSize, underlay, withNumbering, centredBaseline,
  type Arrow, type Note, type PathOp, type Point, type Shape, type Step,
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

/** How the export records a badge's numeral: at the badge's centre across, and
 *  on the baseline that centres it down. */
const numeral = (n: number, [x, y]: readonly number[], weight: number) =>
  `text!:${n}@${x},${centredBaseline(y, stepTextSize(weight))}`;
const shape = (over: Partial<Shape> = {}): Shape =>
  ({ kind: 'box', id: 3, x: 10, y: 20, width: 200, height: 100, color: '#34c759', weight: 8, ...over });
const step = (over: Partial<Step> = {}): Step =>
  ({ kind: 'step', id: 4, x: 100, y: 100, color: '#ff3b30', weight: 10, ...over });

/** Records the calls drawAnnotations makes, so export can be checked without a
 *  canvas. The size stands in for the capture's, which is what a badge is
 *  clamped into. */
function recorder(width = 1200, height = 740) {
  const calls: string[] = [];
  let fontSize = 10;
  const ctx = {
    canvas: { width, height },
    set fillStyle(v: string) { calls.push(`fill:${v}`); },
    set strokeStyle(v: string) { calls.push(`stroke:${v}`); },
    set lineWidth(v: number) { calls.push(`width:${v}`); },
    set globalAlpha(v: number) { calls.push(`alpha:${v}`); },
    set globalCompositeOperation(v: string) { calls.push(`blend:${v}`); },
    set font(v: string) { calls.push(`font:${v}`); fontSize = parseFloat(v.split(' ')[1]); },
    set shadowColor(v: string) { calls.push(`shadow:${v}`); },
    set shadowBlur(v: number) { calls.push(`blur:${v}`); },
    set shadowOffsetX(v: number) { calls.push(`dx:${v}`); },
    set shadowOffsetY(v: number) { calls.push(`dy:${v}`); },
    /** Half an em a character: a stand-in, but a steady one. */
    measureText: (text: string) => ({ width: text.length * fontSize * 0.5 }),
    lineCap: '', lineJoin: '',
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
    expect(calls).toContain(numeral(1, [100, 100], 10));
    expect(calls).toContain(numeral(2, [50, 50], 10));
    // The numeral is painted over its own disc, not under it.
    expect(calls.indexOf('arc:100,100,14.5')).toBeLessThan(calls.indexOf(numeral(1, [100, 100], 10)));
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
    expect(calls).toContain(numeral(1, badgeAt(shape({ kind: 'ellipse', numbered: true }), 1200, 740), 8));
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
    expect(quiet.calls).toContain(numeral(1, [100, 100], 10));
    expect(quiet.calls.join(' ')).not.toContain('say this');

    const loud = recorder();
    drawAnnotations(loud.ctx, [step({ note: 'say this' })], { notes: 'beside' });
    expect(loud.calls).toContain(numeral(1, [100, 100], 10));
    expect(loud.calls.some(call => call.startsWith('text!:say this@'))).toBe(true);
  });
});


describe('holding the angle', () => {
  it('locks to the nearest eighth of a turn', () => {
    // A touch off horizontal comes back to horizontal, keeping how far along it went.
    expect(snapAngle(0, 0, 100, 9)).toEqual([100, 0]);
    expect(snapAngle(0, 0, 9, 100)).toEqual([0, 100]);
    const [x, y] = snapAngle(0, 0, 100, 90);
    expect(x).toBeCloseTo(95);
    expect(y).toBeCloseTo(95);            // the diagonal, and square
    expect(x).toBeCloseTo(y);
  });

  it('projects onto the ray rather than swinging the whole length round', () => {
    // Locked horizontal, dragging further down must not lengthen the line: the
    // end follows how far along the ray the pointer is, not how far it is away.
    expect(snapAngle(0, 0, 100, 3)[0]).toBeCloseTo(100);
    expect(snapAngle(0, 0, 100, 30)[0]).toBeCloseTo(100);
    // And it works from any anchor, in any direction.
    expect(snapAngle(50, 60, -40, 57)).toEqual([-40, 60]);
    expect(snapAngle(50, 60, 47, -20)).toEqual([50, -20]);
  });

  it('leaves a pointer that has not moved alone', () => {
    expect(snapAngle(12, 34, 12, 34)).toEqual([12, 34]);
  });
});


/** The recorder's own measure, for laying out the pills it will be asked to draw. */
const measure = (text: string, font: string) => text.length * parseFloat(font.split(' ')[1]) * 0.5;

describe('looks', () => {
  it('sizes the shadow and the border off the mark’s own weight', () => {
    const shadow = markShadow(20);
    expect(shadow).toEqual({ dx: 0, dy: 3, sigma: 5, opacity: 0.3 });
    expect(shadowReach(shadow)).toBeCloseTo(18);           // three deviations, and the drop
    expect(borderWidth(20)).toBe(4);
  });

  it('borders every swatch in white but the white one', () => {
    const border = Object.fromEntries(COLORS.map(c => [c.name, borderColor(c.value)]));
    expect(border.White).toBe('#1c1c1e');
    for (const name of ['Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'Black']) expect(border[name]).toBe('#ffffff');
  });

  it('pushes a polygon out, rounding the corners it turns out at and meeting where it turns in', () => {
    const square: Point[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const arcs = outsetOps(square, 2).filter(op => op.op === 'arc');
    expect(arcs).toHaveLength(4);
    for (const arc of arcs) expect(arc).toMatchObject({ r: 2, ccw: false });
    // Wound the other way round, it comes out the same way: clockwise, like a
    // disc, so the two add up where a border joins them.
    expect(outsetOps([...square].reverse(), 2).filter(op => op.op === 'arc')).toHaveLength(4);
    const ell: Point[] = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
    const ops = outsetOps(ell, 1);
    expect(ops.filter(op => op.op === 'arc')).toHaveLength(5);
    // The inside corner is where the two pushed-out edges cross.
    expect(ops.find(op => op.op === 'line')).toMatchObject({ x: 5, y: 5 });
  });

  it('writes an outline as SVG path data, a whole circle as two halves', () => {
    expect(pathData([{ op: 'move', x: 0, y: 0 }, { op: 'line', x: 10, y: 0 }, { op: 'close' }]))
      .toBe('M0.00 0.00L10.00 0.00Z');
    expect(pathData([{ op: 'arc', x: 5, y: 5, r: 5, from: 0, to: Math.PI * 2, ccw: false }]))
      .toBe('M10.00 5.00A5.00 5.00 0 1 1 0.00 5.00A5.00 5.00 0 1 1 10.00 5.00');
    // A quarter turn goes the short way round.
    expect(pathData([{ op: 'arc', x: 0, y: 0, r: 2, from: -Math.PI / 2, to: 0, ccw: false }]))
      .toBe('M0.00 -2.00A2.00 2.00 0 0 1 2.00 0.00');
  });

  it('borders a badge so its outer edge lands the border’s width out, filled or stroked', () => {
    const r = stepRadius(10), b = borderWidth(10);
    const bare = underlay(step(), null);                   // a clicked badge: the disc a size up
    expect(bare.stroke).toBeNull();
    expect(bare.ops.find(op => op.op === 'arc')).toMatchObject({ x: 100, y: 100, r: r + b });
    // With a thin arrow the badge is stroked at the arrow's width and the
    // border's, traced far enough in that its outside still lands at r + b.
    const thinStep = step({ to: [300, 100], style: 'line' });
    const under = underlay(thinStep, stepArrow(thinStep));
    const ring = under.ops.find(op => op.op === 'arc') as Extract<PathOp, { op: 'arc' }>;
    expect(ring.r + under.stroke! / 2).toBeCloseTo(r + b);
  });
});

describe('framed notes', () => {
  it('has no pill for a mark with nothing to say, so it keeps its badge', () => {
    expect(pillAt(step(), 1, measure)).toBeNull();
    expect(pillAt(step({ note: '   ' }), 1, measure)).toBeNull();
  });

  it('sits the number where the badge’s would be, and sizes the pill to its words', () => {
    const r = stepRadius(10), size = stepTextSize(10);
    const pill = pillAt(step({ note: 'fix it' }), 3, measure)!;
    expect(pill.height).toBe(r * 2);
    expect(pill.numeral).toEqual([100, 100]);                // the badge's own centre
    expect(pill.x).toBe(100 - r);
    expect(pill.text).toBe('3 fix it');
    // As wide as the badge, plus whatever the words add beyond the number.
    expect(pill.width).toBeCloseTo(r * 2 + ('3 fix it'.length - 1) * size * 0.5);
    // The number is centred on the end's centre.
    expect(pill.textX + (size * 0.5) / 2).toBeCloseTo(100);
  });

  it('slides back inside the image at the edge, still reading number first', () => {
    const pill = pillAt(step({ x: 1180, y: 100, note: 'make this one bigger' }), 1, measure, 1200, 740)!;
    expect(pill.x + pill.width).toBeLessThanOrEqual(1200);
    expect(pill.numeral[0]).toBe(pill.x + pill.height / 2);
    expect(pill.text.startsWith('1 ')).toBe(true);
    // Wider than the whole image, it holds to the left edge.
    expect(pillAt(step({ note: 'x'.repeat(400) }), 1, measure, 1200, 740)!.x).toBe(0);
  });

  it('starts the arrow where it leaves the pill: back through its end, out a side, or through the far end', () => {
    const pill = pillAt(step({ note: 'fix it' }), 1, measure)!;
    const r = pill.height / 2, reach = pill.width - pill.height;
    expect(pillExit(pill, -1, 0)).toBe(r);
    expect(pillExit(pill, 0, 1)).toBe(r);
    expect(pillExit(pill, 1, 0)).toBeCloseTo(reach + r);
    expect(pillExit(pill, Math.SQRT1_2, Math.SQRT1_2)).toBeCloseTo(r * Math.SQRT2);   // out the bottom
    const framed = step({ note: 'fix it', to: [400, 100] });
    const arrowOf = stepArrow(framed, pillAt(framed, 1, measure))!;
    expect(arrowOf.x1).toBeGreaterThan(pill.x + pill.width);
    // Without a pill it is the badge's own arrow, exactly as it always was.
    expect(stepArrow(framed, null)).toEqual(stepArrow(framed));
  });
});

describe('restyling and numbering', () => {
  it('writes only the parts of a style that were named, and only where a mark has them', () => {
    const a = arrow({ style: 'straight' });
    const blue = restyled(a, { color: '#007aff' }, 99) as Arrow;
    expect(blue).toMatchObject({ color: '#007aff', weight: a.weight, style: 'straight' });
    expect(restyled(a, { fill: 'solid' }, 99)).toBe(a);        // a fill is nothing to an arrow
    const box = shape();
    expect(restyled(box, { arrow: 'line', shadow: true }, 99)).toBe(box);
    expect(restyled(a, { shadow: true }, 99)).toMatchObject({ shadow: true });
    expect(restyled(a, { scale: 2 }, 24)).toMatchObject({ weight: 24 });
    // Nothing to change is the same mark back, so there is nothing to undo.
    expect(restyled(blue, { color: '#007aff' }, 99)).toBe(blue);
    // And never what a mark is.
    expect(restyled(step({ to: [300, 100] }), { color: '#000000', border: true }, 99).kind).toBe('step');
  });

  it('turns an arrow into a step and back without losing its looks', () => {
    const a = arrow({ shadow: true, border: true, style: 'line' });
    const s = withNumbering(a, true) as Step;
    expect(s).toMatchObject({ kind: 'step', x: a.x1, y: a.y1, to: [a.x2, a.y2], shadow: true, border: true, style: 'line' });
    const back = withNumbering({ ...s, note: 'goes with the number' }, false) as Arrow;
    expect(back).toMatchObject({ kind: 'arrow', x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, shadow: true, border: true });
    expect('note' in back || 'to' in back).toBe(false);
    expect(withNumbering(a, false)).toBe(a);                   // unchanged is the same mark
    const badge = step();                                      // nothing attached: left alone
    expect(withNumbering(badge, false)).toBe(badge);
  });
});

describe('the looks in the export', () => {
  it('draws nothing extra with the looks off', () => {
    const { ctx, calls } = recorder();
    drawAnnotations(ctx, [arrow(), step({ to: [300, 100] })]);
    expect(calls).not.toContain('save');
    expect(calls.some(call => call.startsWith('shadow:'))).toBe(false);
  });

  it('casts a shadow from the arrow and the disc, and never from the numeral', () => {
    const { ctx, calls } = recorder();
    drawAnnotations(ctx, [step({ to: [300, 100], shadow: true })]);
    expect(calls.filter(call => call.startsWith('shadow:'))).toHaveLength(2);   // the arrow, then the disc
    const disc = calls.indexOf('arc:100,100,14.5');
    expect(calls.lastIndexOf('save', disc)).toBeGreaterThan(-1);
    expect(calls.indexOf('restore', disc)).toBeLessThan(calls.indexOf(numeral(1, [100, 100], 10)));
    expect(calls).toContain(`blur:${markShadow(10).sigma * 2}`);
  });

  it('draws a border first, as one shape that casts the mark’s one shadow', () => {
    const { ctx, calls } = recorder();
    drawAnnotations(ctx, [step({ to: [300, 100], shadow: true, border: true })]);
    expect(calls.filter(call => call.startsWith('shadow:'))).toHaveLength(1);
    const white = calls.indexOf('fill:#ffffff');
    expect(white).toBeGreaterThan(-1);
    expect(calls.indexOf('fill:#ff3b30', white)).toBeGreaterThan(white);   // the colour goes over it
  });

  it('strokes a thin arrow in one go, so it casts one shadow as it shows one', () => {
    const { ctx, calls } = recorder();
    drawAnnotations(ctx, [arrow({ style: 'line', shadow: true })]);
    expect(calls.filter(call => call === 'stroke!')).toHaveLength(1);
    expect(calls.filter(call => call.startsWith('shadow:'))).toHaveLength(1);
  });

  it('scales a shadow by hand on a scaled canvas, since a canvas will not', () => {
    const { ctx, calls } = recorder();
    (ctx as unknown as { getTransform: () => { a: number } }).getTransform = () => ({ a: 0.25 });
    drawAnnotations(ctx, [arrow({ shadow: true })]);
    expect(calls).toContain(`blur:${markShadow(10).sigma * 2 * 0.25}`);
  });

  it('writes a note beside its badge before the disc, as the overlay does', () => {
    const { ctx, calls } = recorder();
    drawAnnotations(ctx, [step({ note: 'say this' })], { notes: 'beside' });
    const words = calls.findIndex(call => call.startsWith('text!:say this@'));
    expect(words).toBeLessThan(calls.indexOf('arc:100,100,14.5'));
    expect(calls.indexOf('arc:100,100,14.5')).toBeLessThan(calls.indexOf(numeral(1, [100, 100], 10)));
  });

  it('frames a note with its number in one pill', () => {
    const { ctx, calls } = recorder();
    drawAnnotations(ctx, [step({ note: 'say this' })], { notes: 'framed' });
    expect(calls.filter(call => call.startsWith('arc:'))).toHaveLength(2);   // the pill's two ends
    expect(calls.some(call => call.startsWith('text!:1 say this@'))).toBe(true);
    expect(calls.some(call => call.startsWith('text!:1@'))).toBe(false);    // no numeral of its own
  });

  it('keeps a badge inside the image rather than the canvas, when the two differ', () => {
    // A thumbnail's canvas is a fraction of the image it shows.
    const { ctx, calls } = recorder(120, 74);
    const box = shape({ x: 1000, y: 600, numbered: true });
    drawAnnotations(ctx, [box], { width: 1200, height: 740 });
    expect(calls).toContain(numeral(1, badgeAt(box, 1200, 740), 8));
  });
});
