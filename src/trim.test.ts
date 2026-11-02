import { describe, expect, it } from 'vitest';
import { CUT, addCut, clock, everything, fitCuts, kept, keptLength, moveCutEdge, moveEdge, playFrom, skip, whole } from './trim';
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

describe('parts cut out of the middle', () => {
  const trim = { start: 0, end: 12 };

  it('keeps what is between the handles and outside the cuts, in order', () => {
    expect(kept(trim, [])).toEqual([trim]);
    expect(kept(trim, [{ start: 3, end: 5 }, { start: 8, end: 9 }])).toEqual([{ start: 0, end: 3 }, { start: 5, end: 8 }, { start: 9, end: 12 }]);
    expect(keptLength(trim, [{ start: 3, end: 5 }, { start: 8, end: 9 }])).toBe(9);
    // A cut against a handle is as good as a trim.
    expect(kept({ start: 1, end: 10 }, [{ start: 1, end: 2 }])).toEqual([{ start: 2, end: 10 }]);
  });

  it('cuts a second around the playhead, inside the handles and clear of other cuts', () => {
    expect(addCut(trim, [], 6)).toEqual([{ start: 5.5, end: 6.5 }]);
    expect(addCut(trim, [], 0.2)).toEqual([{ start: 0, end: CUT }]);
    expect(addCut(trim, [], 11.9)).toEqual([{ start: 11, end: 12 }]);
    // Squeezed between two others, it is shorter.
    expect(addCut(trim, [{ start: 3, end: 5 }, { start: 5.6, end: 7 }], 5.3)).toEqual([{ start: 3, end: 5 }, { start: 5, end: 5.6 }, { start: 5.6, end: 7 }]);
    // Not inside another, nor where too little would be left.
    expect(addCut(trim, [{ start: 3, end: 5 }], 4)).toBeNull();
    expect(addCut({ start: 0, end: 1.2 }, [], 0.6)).toBeNull();
    expect(addCut(trim, [], 13)).toBeNull();
  });

  it('moves a cut\'s ends between its neighbours, never shorter than a fifth of a second', () => {
    const cuts = [{ start: 3, end: 5 }, { start: 8, end: 9 }];
    expect(moveCutEdge(trim, cuts, 0, 'end', 6)).toEqual([{ start: 3, end: 6 }, { start: 8, end: 9 }]);
    expect(moveCutEdge(trim, cuts, 0, 'end', 10)).toEqual([{ start: 3, end: 8 }, { start: 8, end: 9 }]);
    expect(moveCutEdge(trim, cuts, 1, 'start', 2)).toEqual([{ start: 3, end: 5 }, { start: 5, end: 9 }]);
    expect(moveCutEdge(trim, cuts, 0, 'start', 4.95)).toEqual([{ start: 4.8, end: 5 }, { start: 8, end: 9 }]);
    // Leaving under half a second kept, it doesn't move.
    expect(moveCutEdge({ start: 0, end: 2 }, [{ start: 0.2, end: 1 }], 0, 'end', 1.9)).toEqual([{ start: 0.2, end: 1 }]);
    expect(moveCutEdge({ start: 0, end: 2 }, [{ start: 0.5, end: 1 }], 0, 'end', 1.9)).toEqual([{ start: 0.5, end: 1.9 }]);
    expect(moveCutEdge({ start: 0, end: 2 }, [{ start: 0.5, end: 1 }], 0, 'start', -1)).toEqual([{ start: 0, end: 1 }]);
  });

  it('plays over a cut, and from the start once past the end', () => {
    const cuts = [{ start: 3, end: 5 }, { start: 5, end: 6 }];
    expect(skip(4, cuts)).toBe(6);
    expect(skip(2, cuts)).toBe(2);
    expect(playFrom(3.5, trim, cuts)).toBe(6);
    expect(playFrom(11.995, trim, cuts)).toBe(0);
    expect(playFrom(11.5, trim, [{ start: 11, end: 12 }])).toBe(0);
  });

  it('keeps the cuts inside the handles when they move', () => {
    const cuts = [{ start: 1, end: 2 }, { start: 5, end: 7 }, { start: 10, end: 10.5 }];
    expect(fitCuts({ start: 1.5, end: 6 }, cuts)).toEqual([{ start: 1.5, end: 2 }, { start: 5, end: 6 }]);
    expect(fitCuts({ start: 1.9, end: 12 }, cuts)).toEqual([{ start: 5, end: 7 }, { start: 10, end: 10.5 }]);
  });
});
