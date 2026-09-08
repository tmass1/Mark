import { describe, expect, it } from 'vitest';
import { clampRect, fitRatio } from './region';

describe('selection bounds', () => {
  it('keeps a selection on its own display', () => {
    expect(clampRect({ x: -40, y: -10, width: 200, height: 100 }, 1440, 900))
      .toEqual({ x: 0, y: 0, width: 200, height: 100 });
    expect(clampRect({ x: 1400, y: 880, width: 200, height: 100 }, 1440, 900))
      .toEqual({ x: 1240, y: 800, width: 200, height: 100 });
  });

  it('pins an oversized selection to the display instead of pushing it off', () => {
    expect(clampRect({ x: -100, y: -100, width: 5000, height: 5000 }, 1440, 900))
      .toEqual({ x: 0, y: 0, width: 1440, height: 900 });
  });

  it('never reports a negative size', () => {
    const clamped = clampRect({ x: 10, y: 10, width: -50, height: -50 }, 1440, 900);
    expect(clamped.width).toBe(0);
    expect(clamped.height).toBe(0);
  });
});

describe('locked ratio', () => {
  it('grows the shorter side so the pointer stays inside the selection', () => {
    expect(fitRatio(400, 100, 1)).toEqual({ width: 400, height: 400 });   // too wide
    expect(fitRatio(100, 400, 1)).toEqual({ width: 400, height: 400 });   // too tall
  });
  it('leaves a size that already matches alone', () => {
    expect(fitRatio(320, 200, 1.6)).toEqual({ width: 320, height: 200 });
  });
  it('ignores a ratio that cannot be honoured', () => {
    expect(fitRatio(300, 200, 0)).toEqual({ width: 300, height: 200 });
    expect(fitRatio(300, 200, NaN)).toEqual({ width: 300, height: 200 });
  });
});
