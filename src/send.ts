/** What Send gives an AI tool that asked for a screenshot: the capture, at
 *  the size Claude actually looks at, and the words to go with it -- its size,
 *  what was drawn on it and where, and the text in it. Pure, so it is tested
 *  on its own. */
import { numbered, type Annotation, type Point } from './annotations';

/** Claude's high-resolution vision: a long edge of at most 2576 pixels, and
 *  at most 4784 image tokens, a token being a 28-pixel square or any part of
 *  one. The API scales anything larger down itself -- and further for models
 *  that take less -- so more would only be more to send. */
export const MAX_EDGE = 2576;
export const MAX_TOKENS = 4784;
const PATCH = 28;
/** The API's limit on one image, as the base64 that carries it. */
export const MAX_BASE64 = 5 * 1024 * 1024;
/** The words read off a screen are rarely more than a few thousand; past this
 *  they would crowd out the picture in what a tool may take back. */
export const MAX_WORDS = 20_000;
/** A screenshot drawn on more than this is described in part. */
const MAX_MARKS = 60;

export function imageTokens(width: number, height: number): number {
  return Math.ceil(width / PATCH) * Math.ceil(height / PATCH);
}

/** The size to send an image of this size at: itself, if it is within both
 *  limits, and otherwise scaled down, in proportion, until it is. */
export function sendSize(width: number, height: number): { width: number; height: number } {
  const at = (scale: number) => ({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) });
  const fits = (scale: number) => { const size = at(scale); return imageTokens(size.width, size.height) <= MAX_TOKENS; };
  let scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  if (!fits(scale)) {
    // Straight to about the right size, then down in small steps for the
    // squares the rounding leaves over.
    scale = Math.min(scale, Math.sqrt((MAX_TOKENS * PATCH * PATCH) / (width * height)));
    while (scale > 0.01 && !fits(scale)) scale *= 0.99;
  }
  return at(scale);
}

/** Every mark, said in words with where it is, in the pixels of the image as
 *  sent -- `scale` takes the capture's pixels to those. A model sees the
 *  picture; this tells it exactly which part of it each mark means, and what
 *  the user wrote beside each number. Numbered marks first, by number. */
export function describeMarks(items: readonly Annotation[], scale: number): string {
  const at = ([x, y]: Point) => `(${Math.round(x * scale)}, ${Math.round(y * scale)})`;
  const span = (x: number, y: number, width: number, height: number) =>
    `${at([Math.min(x, x + width), Math.min(y, y + height)])}–${at([Math.max(x, x + width), Math.max(y, y + height)])}`;
  const quoted = (note: string | undefined) => (note?.trim() ? `: “${note.trim()}”` : '');
  const said = (item: Annotation): string => {
    switch (item.kind) {
      case 'arrow': return `an arrow from ${at([item.x1, item.y1])} pointing at ${at([item.x2, item.y2])}`;
      case 'line': return `a line from ${at([item.x1, item.y1])} to ${at([item.x2, item.y2])}`;
      case 'measure': return `a measurement from ${at([item.x1, item.y1])} to ${at([item.x2, item.y2])}`;
      case 'pen': {
        const xs = item.points.map(p => p[0]), ys = item.points.map(p => p[1]);
        return xs.length ? `a freehand mark over ${span(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))}` : 'a freehand mark';
      }
      case 'text': return `the words “${item.text.trim()}” written at ${at([item.x, item.y])}`;
      case 'box': return `a box around ${span(item.x, item.y, item.width, item.height)}`;
      case 'ellipse': return `a circle around ${span(item.x, item.y, item.width, item.height)}`;
      case 'highlight': return `a highlight over ${span(item.x, item.y, item.width, item.height)}`;
      case 'redact': return `a redaction over ${span(item.x, item.y, item.width, item.height)}, hidden on purpose`;
      case 'step': return item.to ? `a badge at ${at([item.x, item.y])} with an arrow pointing at ${at(item.to)}` : `a badge at ${at([item.x, item.y])}`;
    }
  };
  const steps = numbered(items);
  const stepIds = new Set(steps.map(step => step.id));
  const rest = items.filter(item => !stepIds.has(item.id) && !(item.kind === 'text' && !item.text.trim()));
  const lines = [
    ...steps.map((item, i) => `${i + 1}. ${said(item)}${quoted(item.note)}`),
    ...rest.map(item => `- ${said(item)}`),
  ];
  if (lines.length > MAX_MARKS) lines.splice(MAX_MARKS, lines.length, `…and ${lines.length - MAX_MARKS} more.`);
  return lines.join('\n');
}

/** What goes with the image: its size as taken and as sent, what the user drew
 *  on it, and the text in it, read on the Mac -- which a model reads far better
 *  as words than out of the picture. */
export function resultText({ capture, sent, marks, words }: {
  capture: { width: number; height: number; scale?: number };
  sent: { width: number; height: number };
  marks: string; words: string;
}): string {
  const scale = capture.scale ?? 1;
  const points = scale === 1 ? ''
    : ` (${Math.round(capture.width / scale)} × ${Math.round(capture.height / scale)} points on a ${+scale.toFixed(2)}× display)`;
  const resized = sent.width === capture.width && sent.height === capture.height ? '' : `, sent at ${sent.width} × ${sent.height}`;
  const lines = [`The user's screenshot, captured with Mark at ${capture.width} × ${capture.height} pixels${points}${resized}.`];
  if (marks.trim()) {
    lines.push('', `What they marked on it, in this image's pixels from its top left — numbered marks are steps they mean in order:`, marks);
  }
  const text = words.trim();
  if (text) {
    const cut = text.length > MAX_WORDS ? `${text.slice(0, MAX_WORDS)}\n…` : text;
    lines.push('', 'The text in it, read on their Mac, in reading order (anything redacted is not included):', cut);
  }
  return lines.join('\n');
}
