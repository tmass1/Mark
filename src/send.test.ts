import { describe, expect, it } from 'vitest';
import { MAX_EDGE, MAX_TOKENS, MAX_WORDS, describeMarks, imageTokens, resultText, sendSize } from './send';
import type { Annotation } from './annotations';

describe('the size a screenshot is sent at', () => {
  it('leaves an image within both limits as it is', () => {
    expect(sendSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(sendSize(1, 1)).toEqual({ width: 1, height: 1 });
  });

  it('brings a long edge down to the limit, keeping its shape', () => {
    // A 5K display, whole: the edge alone brings it within the tokens.
    expect(sendSize(5120, 2880)).toEqual({ width: 2576, height: 1449 });
    const tall = sendSize(1200, 6000);
    expect(tall.height).toBeLessThanOrEqual(MAX_EDGE);
    expect(tall.width / tall.height).toBeCloseTo(0.2, 2);
  });

  it('brings a large area down to the token limit, and no further than it has to', () => {
    // A Retina region: within the edge once scaled, but too many squares.
    const sent = sendSize(3024, 1890);
    expect(imageTokens(sent.width, sent.height)).toBeLessThanOrEqual(MAX_TOKENS);
    expect(sent.width / sent.height).toBeCloseTo(3024 / 1890, 2);
    // Two per cent larger would be over: it isn't shrunk more than the limit asks.
    expect(imageTokens(Math.round(sent.width * 1.02), Math.round(sent.height * 1.02))).toBeGreaterThan(MAX_TOKENS);
    for (const [width, height] of [[2576, 2576], [4000, 3000], [2560, 1600], [9000, 120]]) {
      const size = sendSize(width, height);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(MAX_EDGE);
      expect(imageTokens(size.width, size.height)).toBeLessThanOrEqual(MAX_TOKENS);
    }
  });
});

const base = { id: 0, color: '#ff3b30', weight: 1 };
const MARKS: Annotation[] = [
  { ...base, id: 1, kind: 'arrow', x1: 100, y1: 400, x2: 300, y2: 200 },
  { ...base, id: 2, kind: 'step', x: 600, y: 120, note: 'open the menu' },
  { ...base, id: 3, kind: 'box', x: 900, y: 500, width: -200, height: 100, numbered: true, note: ' pick Export ' },
  { ...base, id: 4, kind: 'redact', x: 40, y: 40, width: 160, height: 30 },
  { ...base, id: 5, kind: 'text', x: 700, y: 640, text: 'Launch day', size: 24 },
  { ...base, id: 6, kind: 'text', x: 0, y: 0, text: '   ', size: 24 },
  { ...base, id: 7, kind: 'step', x: 50, y: 60, to: [250, 260] },
];

describe('what was drawn, said in words', () => {
  it('lists the numbered marks first, by number, with what the user wrote beside each', () => {
    expect(describeMarks(MARKS, 1).split('\n')).toEqual([
      '1. a badge at (600, 120): “open the menu”',
      '2. a box around (700, 500)–(900, 600): “pick Export”',
      '3. a badge at (50, 60) with an arrow pointing at (250, 260)',
      '- an arrow from (100, 400) pointing at (300, 200)',
      '- a redaction over (40, 40)–(200, 70), hidden on purpose',
      '- the words “Launch day” written at (700, 640)',
    ]);
  });

  it('gives places in the pixels of the image as sent', () => {
    expect(describeMarks([MARKS[0]], 0.5)).toBe('- an arrow from (50, 200) pointing at (150, 100)');
  });

  it('says nothing for a capture with nothing drawn on it, and keeps a long list in bounds', () => {
    expect(describeMarks([], 1)).toBe('');
    const many: Annotation[] = Array.from({ length: 80 }, (_, i) => ({ ...base, id: i, kind: 'box', x: i, y: i, width: 10, height: 10 }));
    const lines = describeMarks(many, 1).split('\n');
    expect(lines).toHaveLength(61);
    expect(lines.at(-1)).toBe('…and 20 more.');
  });
});

describe('what is said with it', () => {
  it('gives the size taken, in points too on a Retina display, and the size sent', () => {
    expect(resultText({ capture: { width: 3024, height: 1890, scale: 2 }, sent: { width: 2401, height: 1501 }, marks: '', words: '' }))
      .toBe("The user's screenshot, captured with Mark at 3024 × 1890 pixels (1512 × 945 points on a 2× display), sent at 2401 × 1501.");
    expect(resultText({ capture: { width: 800, height: 600 }, sent: { width: 800, height: 600 }, marks: '', words: '' }))
      .toBe("The user's screenshot, captured with Mark at 800 × 600 pixels.");
  });

  it('adds what was marked and the words in it, each under a heading of its own', () => {
    const text = resultText({ capture: { width: 800, height: 600, scale: 1 }, sent: { width: 800, height: 600 },
                              marks: '1. a badge at (10, 10): “open the menu”', words: 'File  Edit\nExport…' });
    expect(text.split('\n')).toEqual([
      "The user's screenshot, captured with Mark at 800 × 600 pixels.",
      '',
      "What they marked on it, in this image's pixels from its top left — numbered marks are steps they mean in order:",
      '1. a badge at (10, 10): “open the menu”',
      '',
      'The text in it, read on their Mac, in reading order (anything redacted is not included):',
      'File  Edit', 'Export…',
    ]);
  });

  it('keeps the words within bounds', () => {
    const text = resultText({ capture: { width: 8, height: 6 }, sent: { width: 8, height: 6 }, marks: '', words: 'w'.repeat(MAX_WORDS + 500) });
    expect(text.endsWith('\n…')).toBe(true);
    expect(text.length).toBeLessThan(MAX_WORDS + 300);
  });
});
