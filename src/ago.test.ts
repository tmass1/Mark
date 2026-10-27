import { describe, expect, it } from 'vitest';
import { ago } from './ago';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

describe('how long ago Recent says', () => {
  it('says just now for the first minute, and for a clock that went backwards', () => {
    expect(ago(0, 59_999)).toBe('Just now');
    expect(ago(5 * MIN, 0)).toBe('Just now');
  });

  it('counts whole minutes, then hours, then days', () => {
    expect(ago(0, MIN)).toBe('1 min ago');
    expect(ago(0, 59 * MIN + 59_999)).toBe('59 min ago');
    expect(ago(0, HOUR)).toBe('1 h ago');
    expect(ago(0, 23 * HOUR + 59 * MIN)).toBe('23 h ago');
    expect(ago(0, DAY)).toBe('Yesterday');
    expect(ago(0, 2 * DAY)).toBe('2 days ago');
  });
});
