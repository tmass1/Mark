import { describe, expect, it } from 'vitest';
import { arrowPolygon, baseWeight, drawAnnotations, lines, polygonPath, textSize, type Arrow, type Note } from './annotations';

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
