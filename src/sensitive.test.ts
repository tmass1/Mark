import { describe, expect, it } from 'vitest';
import { describeHidden, findSensitive, luhn, type SensitiveKind } from './sensitive';
import type { TextLine } from './text';

/** A line as Vision gives it: words at their places, 8 pixels a letter. */
function line(text: string, y = 20): TextLine {
  let x = 10;
  const words = text.split(' ').map(word => { const w = { text: word, x, y, width: word.length * 8, height: 14 }; x += w.width + 8; return w; });
  return { text, x: 10, y, width: x - 18, height: 14, words };
}
const kinds = (...texts: string[]): SensitiveKind[] => findSensitive(texts.map((text, i) => line(text, 20 + i * 30))).map(f => f.kind);

describe('what is found', () => {
  it('finds an email address', () => {
    expect(kinds('Contact tommy@example.com for access')).toEqual(['email']);
    expect(kinds('mailto:first.last+tag@sub.example.co.uk')).toEqual(['email']);
  });

  it('finds a phone number however it is written', () => {
    expect(kinds('Call +1 (415) 555-0134 today')).toEqual(['phone']);
    expect(kinds('Mobile: 020 7946 0958')).toEqual(['phone']);
    expect(kinds('415.555.0134')).toEqual(['phone']);
    expect(kinds('+447946095812')).toEqual(['phone']);
  });

  it('finds a card number by its check digit, spaced or not', () => {
    expect(kinds('Card 4242 4242 4242 4242 exp 12/27')).toEqual(['card']);
    expect(kinds('5555555555554444')).toEqual(['card']);
  });

  it('finds keys by how they start, and long generated tokens by how they look', () => {
    expect(kinds('OPENAI_API_KEY=sk-proj-AbCdEf1234567890GhIjKl')).toEqual(['key']);
    expect(kinds('sk_live_51HcAbCdEfGh12345678')).toEqual(['key']);
    expect(kinds('token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4')).toEqual(['key']);
    expect(kinds('AKIAIOSFODNN7EXAMPLE')).toEqual(['key']);
    expect(kinds('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N')).toEqual(['key']);
    expect(kinds('secret: q8Zr3XkP2vLm9WnT4bYc7HdS1fGj')).toEqual(['key']);
  });

  it('finds several on a line, each once, the surest kind first', () => {
    // A card number is digits a phone pattern would take too: it is a card.
    expect(kinds('a@b.io or 4242424242424242 or +1 415 555 0134')).toEqual(['email', 'card', 'phone']);
  });
});

describe('what is left alone', () => {
  it('leaves dates, times, prices, versions and addresses on a network', () => {
    expect(kinds('Updated 2024-10-08 14:30', 'Total $1,240.00', 'Version 0.5.1 (2026)',
                 'Server 192.168.1.100', 'Order #10482 · 14 items')).toEqual([]);
  });

  it('leaves a number that fails the card check, and slugs that only contain a prefix', () => {
    expect(kinds('Ref 4242424242424241', 'task-management-system-overview-page')).toEqual([]);
  });

  it('leaves commit hashes, UUIDs and long ordinary words', () => {
    expect(kinds('commit 9fceb02d0ae598e95dc970b74767f19372d61af8', 'id 123e4567-e89b-12d3-a456-426614174000',
                 'Antidisestablishmentarianism and supercalifragilistic')).toEqual([]);
  });
});

describe('where it is', () => {
  it('covers the words a match touches, with a little room round them', () => {
    const [found] = findSensitive([line('Call +1 (415) 555-0134 today')]);
    // "+1" starts after "Call " -- 5 letters and a gap in -- and "555-0134" ends before " today".
    const call = 10 + 4 * 8 + 8, today = 10 + (4 + 2 + 5 + 8) * 8 + 4 * 8;
    expect(found.area.x).toBeLessThan(call);
    expect(found.area.x).toBeGreaterThan(call - 8);
    expect(found.area.x + found.area.width).toBeGreaterThan(today - 8);
    expect(found.area.y).toBeLessThan(20);
    expect(found.area.y + found.area.height).toBeGreaterThan(34);
  });

  it('pads a face, which Vision boxes tightly', () => {
    const [face] = findSensitive([], [{ x: 100, y: 100, width: 50, height: 60 }]);
    expect(face.kind).toBe('face');
    expect(face.area).toEqual({ x: 94, y: 94, width: 62, height: 72 });
  });
});

describe('the summary', () => {
  it('says what was hidden plainly', () => {
    const found = findSensitive([line('a@b.io and c@d.io')], [{ x: 0, y: 0, width: 10, height: 10 }]);
    expect(describeHidden(found)).toBe('Hid 2 email addresses and a face.');
    expect(describeHidden(findSensitive([line('+1 415 555 0134 4242424242424242 sk_test_AbCdEfGh12345678')])))
      .toBe('Hid a phone number, a card number and a key.');
    expect(describeHidden([])).toBe('');
  });

  it('checks a card number as Luhn did', () => {
    expect(luhn('4242424242424242')).toBe(true);
    expect(luhn('4242424242424241')).toBe(false);
    expect(luhn('79927398713')).toBe(true);
  });
});
