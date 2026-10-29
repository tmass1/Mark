import { describe, expect, it } from 'vitest';
import { clock, everything, moveEdge, playFrom, whole } from './trim';
import { suggestedName } from './names';

describe('trim', () => {
  it('reads a time to the second', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(12.4)).toBe('0:12');
    expect(clock(245)).toBe('4:05');
    expect(clock(-3)).toBe('0:00');
  });

  it('keeps all of a recording until a handle moves', () => {
    expect(whole(everything(12), 12)).toBe(true);
    expect(whole({ start: 0.02, end: 11.97 }, 12)).toBe(true);
    expect(whole({ start: 1, end: 12 }, 12)).toBe(false);
  });

  it('moves a handle within the recording and never closer than half a second to the other', () => {
    const all = everything(10);
    expect(moveEdge(all, 'start', 3, 10)).toEqual({ start: 3, end: 10 });
    expect(moveEdge(all, 'end', 4, 10)).toEqual({ start: 0, end: 4 });
    expect(moveEdge(all, 'start', -2, 10)).toEqual({ start: 0, end: 10 });
    expect(moveEdge(all, 'end', 14, 10)).toEqual({ start: 0, end: 10 });
    expect(moveEdge({ start: 2, end: 4 }, 'start', 3.9, 10)).toEqual({ start: 3.5, end: 4 });
    expect(moveEdge({ start: 2, end: 4 }, 'end', 1, 10)).toEqual({ start: 2, end: 2.5 });
    expect(moveEdge(all, 'start', Number.NaN, 10)).toBe(all);
    // Shorter than half a second: the handles can only meet.
    expect(moveEdge(everything(0.3), 'end', 0, 0.3)).toEqual({ start: 0, end: 0.3 });
  });

  it('plays the part kept, round and round', () => {
    const kept = { start: 2, end: 5 };
    expect(playFrom(3, kept)).toBe(3);
    expect(playFrom(5, kept)).toBe(2);
    expect(playFrom(0.5, kept)).toBe(2);
  });
});

describe('names', () => {
  it('names a recording as a screenshot is named, as what it is saved as', () => {
    const at = new Date(2026, 9, 29, 9, 41, 7);
    expect(suggestedName(at)).toBe('Mark 2026-10-29 at 09.41.07.png');
    expect(suggestedName(at, 'mp4')).toBe('Mark 2026-10-29 at 09.41.07.mp4');
    expect(suggestedName(at, 'gif')).toBe('Mark 2026-10-29 at 09.41.07.gif');
  });
});
