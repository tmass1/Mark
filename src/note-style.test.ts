import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTE_STYLE, NOTE_STYLES, NOTE_STYLE_NAMES, courseAlone, courseFrom, curvedArrow, faded, isNoteStyle, noteLook, shade, type Course } from './note-style';

const WHITE = '#ffffff', BLACK = '#1c1c1e', RED = '#ff3b30';
const frame = { x: 100, y: 100, width: 300, height: 40 };
const head = (polygon: [number, number][], [x, y]: [number, number]) => polygon.some(p => p[0] === x && p[1] === y);

describe('the note styles', () => {
  it('offers four, Smoked glass by default, each with a name', () => {
    expect(NOTE_STYLES).toHaveLength(4);
    expect(DEFAULT_NOTE_STYLE).toBe('smoked');
    for (const style of NOTE_STYLES) {
      expect(isNoteStyle(style)).toBe(true);
      expect(NOTE_STYLE_NAMES[style]).toBeTruthy();
    }
    expect(isNoteStyle('neon')).toBe(false);
    expect(isNoteStyle(null)).toBe(false);
  });

  it('shades a colour towards white or black, and leaves anything else alone', () => {
    expect(shade('#808080', 1)).toBe('#ffffff');
    expect(shade('#808080', -1)).toBe('#000000');
    expect(shade('#808080', 0)).toBe('#808080');
    expect(shade('hsl(10 50% 50%)', 0.5)).toBe('hsl(10 50% 50%)');
    expect(faded('#ff0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)');
    expect(faded('hsl(10 50% 50%)', 0.5)).toBe('hsl(10 50% 50%)');
  });

  it('keeps a white arrow visible on a light screen, and a black one on a dark', () => {
    for (const style of NOTE_STYLES) {
      expect(noteLook(style, WHITE, BLACK).arrow.edge?.color).toContain('28, 28, 30');
      expect(noteLook(style, BLACK, WHITE).arrow.edge).not.toBeNull();
    }
    // A coloured arrow in Icon glass has no edge at all: its light is its own.
    expect(noteLook('icon', RED, WHITE).arrow.edge).toBeNull();
    expect(noteLook('icon', RED, WHITE).arrow.lit).not.toBeNull();
  });

  it('lets a little of the screen through the smoked pane, and only there', () => {
    const opacity = (color: string) => Number(/rgba\(.*, ([\d.]+)\)/.exec(color)?.[1] ?? 1);
    for (const [, color] of noteLook('smoked', RED, WHITE).frame) {
      expect(opacity(color)).toBeGreaterThan(0.8);
      expect(opacity(color)).toBeLessThan(1);
    }
    for (const style of ['solid', 'card', 'icon'] as const) {
      for (const [, color] of noteLook(style, RED, WHITE).frame) expect(opacity(color)).toBe(1);
    }
    // And the arrow starts at its edge, or its tail would show through as well.
    expect(noteLook('smoked', RED, WHITE).arrow.tuck).toBe(0);
    expect(noteLook('card', RED, WHITE).arrow.tuck).toBeGreaterThan(0);
  });

  it('keeps the number readable against whatever it sits on', () => {
    // Black on the smoked pane would vanish, so it gets a rim.
    expect(noteLook('smoked', BLACK, WHITE).numberRim).not.toBeNull();
    expect(noteLook('smoked', RED, WHITE).numberRim).toBeNull();
    // White on the white card would too, so the tile turns dark.
    expect(noteLook('card', WHITE, BLACK).numberFill[0][1]).toBe(BLACK);
    expect(noteLook('card', WHITE, BLACK).numberInk).toBe(WHITE);
    // The words on the card and the smoked pane are the pane's, not the colour's.
    expect(noteLook('card', RED, WHITE).wordsInk).toBe(BLACK);
    expect(noteLook('smoked', RED, WHITE).wordsInk).toBe('#f5f5f7');
    expect(noteLook('solid', RED, WHITE).wordsInk).toBe(WHITE);
  });
});

describe('the arrow’s course', () => {
  it('leaves by the rounded end for a point well past it, tucked under the frame', () => {
    const course = courseFrom(frame, [700, 130], 2)!;
    expect(course.from[0]).toBeGreaterThan(380 - 20);
    expect(course.from[0]).toBeLessThan(400);       // inside the end, under the frame
    expect(course.to).toEqual([700, 130]);
    const left = courseFrom(frame, [10, 120], 2)!;
    expect(left.from[0]).toBeGreaterThan(100);
    expect(left.from[0]).toBeLessThan(120);
  });

  it('leaves square off the long edge for a point above or below', () => {
    const below = courseFrom(frame, [250, 400], 2)!;
    expect(below.from[1]).toBe(138);                // inside the bottom edge
    expect(below.c1[0]).toBe(below.from[0]);        // straight out, before it eases over
    const above = courseFrom(frame, [250, 10], 2)!;
    expect(above.from[1]).toBe(102);
    // Never from past the round end, wherever the point is across.
    const far = courseFrom(frame, [410, 800], 2)!;
    expect(far.from[0]).toBeLessThanOrEqual(380);
  });

  it('has no course to a point inside the frame', () => {
    expect(courseFrom(frame, [200, 120], 2)).toBeNull();
  });

  it('leaves a round badge outward, whichever way it points', () => {
    const badge = { x: 100, y: 100, width: 40, height: 40 };
    for (const [x, y] of [[300, 120], [120, 300], [10, 120], [120, 10], [300, 300]] as const) {
      const course = courseFrom(badge, [x, y], 2)!;
      expect(Math.hypot(course.from[0] - 120, course.from[1] - 120)).toBeCloseTo(18);
      const out = Math.hypot(x - course.from[0], y - course.from[1]);
      expect(out).toBeLessThan(Math.hypot(x - 120, y - 120));
    }
  });

  it('bows an arrow on its own, rising whichever way it is drawn', () => {
    for (const [from, to] of [[[0, 0], [200, 0]], [[200, 0], [0, 0]]] as const) {
      const { c1, c2 } = courseAlone([...from], [...to]);
      expect(c1[1]).toBeLessThan(0);
      expect(c2[1]).toBeLessThan(0);
    }
  });
});

describe('the arrow’s shape', () => {
  const course: Course = courseAlone([0, 0], [300, 120]);

  it('puts the tip exactly where it was aimed, in every style', () => {
    for (const style of NOTE_STYLES) {
      const polygon = curvedArrow(course, noteLook(style, RED, WHITE).arrow, 1)!;
      expect(head(polygon, [300, 120])).toBe(true);
    }
  });

  it('draws nothing when the course cannot hold its own head', () => {
    const look = noteLook('icon', RED, WHITE).arrow;
    expect(curvedArrow(courseAlone([0, 0], [look.headLength, 0]), look, 1)).toBeNull();
    expect(curvedArrow(courseAlone([0, 0], [look.headLength * 2, 0]), look, 1)).not.toBeNull();
  });

  it('scales with the mark, in every part of it', () => {
    const look = noteLook('smoked', RED, WHITE).arrow;
    const width = (scale: number) => {
      const ys = curvedArrow(courseAlone([0, 0], [400, 0]), look, scale)!.map(point => point[1]);
      return Math.max(...ys) - Math.min(...ys);
    };
    // The head is what is widest, and it is the look's times the unit.
    const bow = 400 * 0.08 * 0.75;
    expect(width(1)).toBeGreaterThan(look.headWidth);
    expect(width(2)).toBeGreaterThan(width(1));
    expect(width(1)).toBeLessThan(look.headWidth * 2 + bow);
  });

  it('is a clean run of points, with no point repeated', () => {
    for (const style of NOTE_STYLES) {
      const polygon = curvedArrow(course, noteLook(style, RED, WHITE).arrow, 1)!;
      for (const value of polygon.flat()) expect(Number.isFinite(value)).toBe(true);
      expect(polygon.length).toBeGreaterThan(40);
    }
  });
});
