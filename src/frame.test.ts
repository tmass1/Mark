import { describe, expect, it } from 'vitest';
import { BACKGROUNDS, DEFAULT_FRAME, cssBackground, frameGeometry, gradientLine, sanitizeFrame } from './frame';

describe('frame geometry', () => {
  it('is a share of the image, so a small capture and a large one look alike', () => {
    const small = frameGeometry(400, 250, 1, DEFAULT_FRAME);
    const large = frameGeometry(1600, 1000, 1, DEFAULT_FRAME);
    expect(large.pad / 1600).toBeCloseTo(small.pad / 400, 2);
    expect(large.radius / 1600).toBeCloseTo(small.radius / 400, 2);
    // Padding goes round every side; the image sits whole inside it.
    expect(large.width).toBe(1600 + 2 * large.pad);
    expect(large.height).toBe(1000 + 2 * large.pad);
  });

  it('is whole pixels, so the image lands on the grid', () => {
    const g = frameGeometry(1437, 911, 2, { ...DEFAULT_FRAME, chrome: true, padding: 0.37, radius: 0.61, shadow: 0.29 });
    for (const value of [g.width, g.height, g.pad, g.bar, g.radius, g.shadow.blur, g.shadow.y]) expect(Number.isInteger(value)).toBe(true);
  });

  it('gives a title bar a real one\'s 28 points, at the capture\'s density, on top of the padding', () => {
    expect(frameGeometry(800, 500, 1, { ...DEFAULT_FRAME, chrome: true }).bar).toBe(28);
    const retina = frameGeometry(1600, 1000, 2, { ...DEFAULT_FRAME, chrome: true });
    expect(retina.bar).toBe(56);
    expect(retina.height).toBe(1000 + 56 + 2 * retina.pad);
    expect(frameGeometry(800, 500, 2, DEFAULT_FRAME).bar).toBe(0);
  });

  it('has no padding, corners or shadow when all three are turned down', () => {
    const g = frameGeometry(800, 500, 1, { ...DEFAULT_FRAME, padding: 0, radius: 0, shadow: 0 });
    expect(g).toEqual({ width: 800, height: 500, pad: 0, bar: 0, radius: 0, shadow: { blur: 0, y: 0, alpha: 0 } });
  });

  it('never rounds a corner past half the window', () => {
    const g = frameGeometry(40, 2000, 1, { ...DEFAULT_FRAME, radius: 1 });
    expect(g.radius).toBeLessThanOrEqual(20);
  });
});

describe('gradients', () => {
  // CSS's own rule: through the centre at the angle, long enough that the
  // corners take the end colours -- so the canvas draws what the page shows.
  it('runs along the line CSS draws a linear-gradient on', () => {
    const ends = (line: ReturnType<typeof gradientLine>) => [line.x0, line.y0, line.x1, line.y1].map(v => Math.round(v * 1e6) / 1e6);
    expect(ends(gradientLine(90, 200, 100))).toEqual([0, 50, 200, 50]);
    expect(ends(gradientLine(0, 200, 100))).toEqual([100, 100, 100, 0]);
    // At 135 degrees the line's length is w·sin + h·cos, corner to corner in effect.
    const diagonal = gradientLine(135, 200, 100);
    expect(Math.hypot(diagonal.x1 - diagonal.x0, diagonal.y1 - diagonal.y0))
      .toBeCloseTo(200 * Math.SQRT1_2 + 100 * Math.SQRT1_2, 6);
    expect(diagonal.x1).toBeGreaterThan(diagonal.x0);
    expect(diagonal.y1).toBeGreaterThan(diagonal.y0);               // toward the bottom right
  });

  it('are written for the page as the canvas paints them', () => {
    expect(cssBackground(BACKGROUNDS.find(b => b.id === 'sky')!)).toBe('linear-gradient(135deg, #a1c4fd, #c2e9fb)');
    expect(cssBackground(BACKGROUNDS.find(b => b.id === 'white')!)).toBe('#ffffff');
    expect(cssBackground(BACKGROUNDS.find(b => b.id === 'clear')!)).toMatch(/^repeating-conic-gradient/);
  });

  it('come six of each, with no two alike', () => {
    expect(BACKGROUNDS.filter(b => b.stops.length > 1)).toHaveLength(6);
    expect(BACKGROUNDS.filter(b => b.stops.length <= 1)).toHaveLength(6);
    expect(new Set(BACKGROUNDS.map(b => b.id)).size).toBe(BACKGROUNDS.length);
  });
});

describe('a stored frame', () => {
  it('keeps what it can and falls back on the rest', () => {
    expect(sanitizeFrame(undefined)).toEqual(DEFAULT_FRAME);
    expect(sanitizeFrame({ on: true, background: 'dusk', padding: 0.2 }))
      .toEqual({ ...DEFAULT_FRAME, on: true, background: 'dusk', padding: 0.2 });
    // Out of range, not a number, or a background that does not exist.
    expect(sanitizeFrame({ padding: 7, radius: -1, shadow: Number.NaN, background: 'plaid', chrome: 'yes' }))
      .toEqual({ ...DEFAULT_FRAME, padding: 1, radius: 0 });
  });
});
