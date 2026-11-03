import { describe, expect, it } from 'vitest';
import { cameraAt, gifPlan, lengthOf, outputSize, overlayAt, partsOf, sourceAt } from './compose';

describe('what a copy of a recording keeps', () => {
  it('is the part between the handles, less what is cut out of it', () => {
    expect(partsOf(1, 9, [])).toEqual([{ start: 1, end: 9 }]);
    expect(partsOf(1, 9, [[3, 4], [6, 7]])).toEqual([{ start: 1, end: 3 }, { start: 4, end: 6 }, { start: 7, end: 9 }]);
    expect(partsOf(1, 9, [[1, 2], [8, 9]])).toEqual([{ start: 2, end: 8 }]);
  });

  it('runs for what it keeps, faster at a higher speed, and skips what is cut', () => {
    const parts = partsOf(0, 10, [[4, 6]]);
    expect(lengthOf(parts, 1)).toBe(8);
    expect(lengthOf(parts, 2)).toBe(4);
    expect(sourceAt(parts, 1, 3.5)).toBe(3.5);
    expect(sourceAt(parts, 1, 4.5)).toBe(6.5);
    expect(sourceAt(parts, 2, 2.5)).toBe(7);
    expect(sourceAt(parts, 1, 99)).toBe(10);
  });
});

describe('what is drawn on a frame', () => {
  it('takes the marks due by then, a frame early', () => {
    expect(overlayAt([1, 3], 0.5)).toBe(-1);
    expect(overlayAt([1, 3], 1 - 1 / 120)).toBe(0);
    expect(overlayAt([1, 3], 9)).toBe(1);
  });

  it('follows the camera through a zoom, and shows the whole picture outside one', () => {
    const track: [number, number, number, number][] = [[1, 100, 100, 1.2], [1.1, 200, 100, 1.4], [5, 300, 300, 1.5], [5.03, 300, 300, 1]];
    expect(cameraAt(track, 0.5)).toBeNull();
    const between = cameraAt(track, 1.05)!;
    expect(between[0]).toBeCloseTo(150);
    expect(between[2]).toBeCloseTo(1.3);
    expect(cameraAt(track, 3)).toBeNull();
    expect(cameraAt(track, 5.03)).toBeNull();
  });
});

describe('the size of a copy', () => {
  it('is in even pixels, and no larger than H.264 takes', () => {
    expect(outputSize(1001, 601)).toEqual([1000, 600]);
    expect(outputSize(7680, 2160)).toEqual([3840, 1080]);
  });

  it('makes a GIF as the app does: 15 a second up to 1280 across, or small', () => {
    const parts = partsOf(0, 2, []);
    const full = gifPlan(parts, 1, [2880, 1800], 2, false);
    expect(full.times).toHaveLength(30);
    expect(full.size).toEqual([1280, 800]);
    const small = gifPlan(parts, 2, [2880, 1800], 2, true);
    expect(small.times).toHaveLength(10);
    expect(small.size).toEqual([640, 400]);
    expect(small.times[5]).toBeCloseTo(1);
  });
});
