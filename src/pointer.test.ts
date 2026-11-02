import { describe, expect, it } from 'vitest';
import { PRESS_SHORTEST, RIPPLE_TIME, pointerAt, pressedAt, rippleShape, ripplesAt } from './pointer';

describe('where the pointer was', () => {
  const track = [[0, 10, 10], [0.1, 20, 30], [1, 90, 90]] as const;

  it('is between two moments in proportion, as Rust reckons it', () => {
    expect(pointerAt(track, 0.05)).toEqual([15, 20]);
    expect(pointerAt(track, 0)).toEqual([10, 10]);
  });

  it('stays where it was for a moment, then is nowhere', () => {
    expect(pointerAt(track, 0.2)).toEqual([20, 30]);
    expect(pointerAt(track, 0.5)).toBeNull();
    expect(pointerAt(track, 1.1)).toEqual([90, 90]);
    expect(pointerAt(track, 2)).toBeNull();
    expect(pointerAt(track, -1)).toBeNull();
    expect(pointerAt([], 0)).toBeNull();
  });
});

describe('presses', () => {
  const presses = [[1, 1.5], [2, 2.01]] as const;

  it('show while the button is down, and a quick tap for long enough to see', () => {
    expect([0.9, 1, 1.4, 1.6].map(t => pressedAt(presses, t))).toEqual([false, true, true, false]);
    expect(pressedAt(presses, 2.1)).toBe(true);
    expect(pressedAt(presses, 2 + PRESS_SHORTEST + 0.01)).toBe(false);
  });

  it('start a ripple that runs its own time, as Rust draws it', () => {
    expect(ripplesAt(presses, 0.99)).toEqual([]);
    expect(ripplesAt(presses, 1)).toEqual([[1, 0]]);
    const [[down, progress]] = ripplesAt(presses, 1 + RIPPLE_TIME / 2);
    expect(down).toBe(1);
    expect(progress).toBeCloseTo(0.5);
    expect(ripplesAt(presses, 1 + RIPPLE_TIME)).toEqual([]);
    expect(rippleShape(0)).toEqual([0.35, 1]);
    expect(rippleShape(1)).toEqual([1, 0]);
    expect(rippleShape(0.5)[0]).toBeGreaterThan(0.35 + 0.65 * 0.5);
  });
});
