import { describe, expect, it } from 'vitest';
import { lookItems, lookLabel, lookOf, recordsArrow, unavailable, type Look } from './look';

describe('a recording’s pointer and clicks', () => {
  it('are held to the choices there are', () => {
    expect(lookOf({ pointer: 'touch', clicks: 'ripple' })).toEqual({ pointer: 'touch', clicks: 'ripple' });
    expect(lookOf({ pointer: 'laser', clicks: 7 })).toEqual({ pointer: 'arrow', clicks: 'rings' });
    expect(lookOf(null)).toEqual({ pointer: 'arrow', clicks: 'rings' });
    expect(lookLabel({ pointer: 'touch', clicks: 'none' })).toBe('Touch · None');
  });

  it('keep what macOS recorded into the movie, and change what Mark draws', () => {
    expect(recordsArrow('halo') && !recordsArrow('touch')).toBe(true);
    const arrow: Look = { pointer: 'arrow', clicks: 'rings' };
    // The arrow is in the movie: a halo can be added or taken off, no more.
    expect(['arrow', 'halo', 'touch', 'hidden'].map(choice => unavailable(arrow, choice as Look['pointer'])))
      .toEqual([null, null, 'The arrow is in this one', 'The arrow is in this one']);
    expect(['rings', 'ripple', 'none'].map(choice => unavailable(arrow, choice as Look['clicks'])))
      .toEqual([null, 'Rings are in this one', 'Rings are in this one']);
    const touch: Look = { pointer: 'touch', clicks: 'ripple' };
    expect(['arrow', 'halo', 'touch', 'hidden'].map(choice => unavailable(touch, choice as Look['pointer'])))
      .toEqual(['Recorded without it', 'Recorded without it', null, null]);
    expect(['rings', 'ripple', 'none'].map(choice => unavailable(touch, choice as Look['clicks'])))
      .toEqual(['Only while recording', null, null]);
  });

  it('are offered as a menu, the one chosen ticked and what can’t be had dimmed', () => {
    const menu = lookItems({ pointer: 'hidden', clicks: 'ripple' }, { pointer: 'touch', clicks: 'ripple' });
    const items = [...menu.matchAll(/data-(pointer|clicks)="(\w+)"\s+aria-checked="(true|false)"( aria-disabled="true")?/g)]
      .map(([, , id, checked, dimmed]) => `${id}${checked === 'true' ? ' ✓' : ''}${dimmed ? ' dimmed' : ''}`);
    expect(items).toEqual(['arrow dimmed', 'halo dimmed', 'touch', 'hidden ✓', 'rings dimmed', 'ripple ✓', 'none']);
    expect(menu).toContain('Only while recording');
    // Before recording, everything can be had.
    expect(lookItems({ pointer: 'arrow', clicks: 'rings' })).not.toContain('aria-disabled');
  });
});
