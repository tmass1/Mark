import { describe, expect, it } from 'vitest';
import { readingOrder, within, type TextLine } from './text';

/** A line laid out as Vision would report it: each word at its own place. */
function line(y: number, x: number, ...words: string[]): TextLine {
  let at = x;
  const placed = words.map(text => { const word = { text, x: at, y, width: text.length * 10, height: 20 }; at += word.width + 10; return word; });
  return { text: words.join(' '), x, y, width: at - 10 - x, height: 20, words: placed };
}

describe('reading order', () => {
  it('reads rows top to bottom, whatever order they were found in', () => {
    expect(readingOrder([line(100, 10, 'second'), line(40, 10, 'first'), line(160, 10, 'third')]))
      .toBe('first\nsecond\nthird');
  });

  it('puts what shares a row side by side, left to right, a tab apart', () => {
    // A table row whose cells came back as separate lines, a little out of true.
    const cells = [line(52, 400, '$1,240.00'), line(50, 10, '#10482'), line(51, 120, 'Lantern', 'Studio')];
    expect(readingOrder([...cells, line(90, 10, '#10481')])).toBe('#10482\tLantern Studio\t$1,240.00\n#10481');
  });

  it('keeps lines that merely touch on separate rows', () => {
    expect(readingOrder([line(10, 10, 'above'), line(25, 300, 'below')])).toBe('above\nbelow');
  });

  it('is nothing for nothing', () => {
    expect(readingOrder([])).toBe('');
  });

  it('reads a sidebar by itself, not as labels for whatever shares its rows', () => {
    // A sidebar down the left, and a content column whose rows only now and
    // then happen to line up with it.
    const sidebar = ['Overview', 'Orders', 'Customers', 'Inventory', 'Settings'].map((text, i) => line(40 + i * 40, 10, text));
    const content = [line(30, 300, 'Revenue'), line(70, 300, '$184,320'), line(130, 300, 'Orders', 'this', 'week'), line(190, 300, 'Chart')];
    expect(readingOrder([...content, ...sidebar]))
      .toBe('Overview\nOrders\nCustomers\nInventory\nSettings\nRevenue\n$184,320\nOrders this week\nChart');
  });

  it('keeps a table a table, though its columns have gutters too', () => {
    const table = [0, 1, 2].flatMap(row => [line(40 + row * 30, 10, `#1048${row}`), line(40 + row * 30, 200, 'Shipped'), line(40 + row * 30, 400, '$96.00')]);
    expect(readingOrder(table)).toBe('#10480\tShipped\t$96.00\n#10481\tShipped\t$96.00\n#10482\tShipped\t$96.00');
  });
});

describe('the text in a box', () => {
  const page = [line(40, 10, 'Order', 'Customer', 'Total'), line(80, 10, '#10482', 'Lantern', 'Studio')];

  it('keeps the words whose middles are inside it, and the lines they make', () => {
    // A box round the first two words of both lines: Order, Customer, #10482, Lantern.
    const kept = within(page, { x: 0, y: 30, width: 155, height: 80 });
    expect(kept.map(l => l.text)).toEqual(['Order Customer', '#10482 Lantern']);
    expect(readingOrder(kept)).toBe('Order Customer\n#10482 Lantern');
    // And one round the second line alone takes all of it and nothing above.
    expect(readingOrder(within(page, { x: 0, y: 75, width: 400, height: 30 }))).toBe('#10482 Lantern Studio');
  });

  it('takes a word an edge cuts through to the side with most of it', () => {
    // "Customer" runs from 70 to 150; an edge at 105 leaves most of it outside.
    expect(within(page, { x: 0, y: 30, width: 105, height: 20 }).map(l => l.text)).toEqual(['Order']);
    expect(within(page, { x: 0, y: 30, width: 115, height: 20 }).map(l => l.text)).toEqual(['Order Customer']);
  });

  it('is nothing when the box holds no words', () => {
    expect(within(page, { x: 500, y: 500, width: 10, height: 10 })).toEqual([]);
  });
});
