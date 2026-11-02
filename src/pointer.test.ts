import { describe, expect, it } from 'vitest';
import { pointerAt } from './pointer';

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
