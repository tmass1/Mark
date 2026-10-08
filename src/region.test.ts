import { describe, expect, it } from 'vitest';
import { clampRect, fitRatio, ratioInside, ratioRect } from './region';

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

describe('a crop held to a shape', () => {
  it('follows whichever side the pointer pulls further, at the ratio', () => {
    expect(ratioRect(100, 100, 300, 120, 2, 1000, 1000)).toEqual({ x: 100, y: 100, width: 200, height: 100 });
    expect(ratioRect(100, 100, 120, 300, 2, 1000, 1000)).toEqual({ x: 100, y: 100, width: 400, height: 200 });
  });

  it('grows from the fixed corner toward the pointer, whichever way that is', () => {
    expect(ratioRect(500, 500, 300, 400, 1, 1000, 1000)).toEqual({ x: 300, y: 300, width: 200, height: 200 });
  });

  it('shrinks at the image\'s edge rather than bending the ratio', () => {
    const crop = ratioRect(800, 100, 1200, 400, 16 / 9, 1000, 1000);   // wants 533 wide; 200 to the edge
    expect(crop.x).toBe(800);
    expect(crop.width).toBeCloseTo(200, 9);
    expect(crop.width / crop.height).toBeCloseTo(16 / 9, 9);
  });

  it('is nothing for a press without a drag', () => {
    expect(ratioRect(50, 50, 50, 50, 1, 100, 100)).toEqual({ x: 50, y: 50, width: 0, height: 0 });
  });

  it('fits the largest of a shape inside a rectangle, centred in it', () => {
    expect(ratioInside({ x: 0, y: 0, width: 1200, height: 740 }, 1)).toEqual({ x: 230, y: 0, width: 740, height: 740 });
    expect(ratioInside({ x: 100, y: 100, width: 400, height: 400 }, 16 / 9))
      .toEqual({ x: 100, y: 187.5, width: 400, height: 225 });
  });
});
