/** Hide Sensitive: what in a capture's words -- and which of its faces --
 *  should not be shown to whoever it is sent to. Rust reads the words and
 *  finds the faces; this decides what among the words is an email address, a
 *  phone number, a card number or a key, and where each one is. Pure, so its
 *  hits and its misses are tested on their own. It errs towards hiding: a
 *  number pixelated that was harmless costs a ⌘Z, and the other way round
 *  costs a secret. */
import type { Area, TextLine, TextWord } from './text';

export type SensitiveKind = 'email' | 'phone' | 'card' | 'key' | 'face';
export interface Sensitive { kind: SensitiveKind; area: Area }

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** Keys and tokens that say what they are by how they start -- at the start
 *  of a word, so "task-management-…" is not an sk- key. A word boundary rather
 *  than a lookbehind: macOS 13's first WebKit cannot parse a lookbehind. */
const KEY = new RegExp('\\b(?:' + [
  'sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}',                  // OpenAI, Anthropic
  '(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}',           // Stripe
  'gh[pousr]_[A-Za-z0-9]{20,}', 'github_pat_[A-Za-z0-9_]{20,}',
  'xox[abprs]-[A-Za-z0-9-]{10,}',                           // Slack
  'AKIA[0-9A-Z]{16}',                                        // AWS
  'AIza[0-9A-Za-z_-]{30,}',                                  // Google
  'glpat-[A-Za-z0-9_-]{20,}',                                // GitLab
  'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}', // a JWT
].join('|') + ')', 'g');
const TOKEN = /[A-Za-z0-9_+/=-]{24,}/g;
/** A word that is part of a number as people write one: digits, and the +,
 *  brackets, dots and dashes around them -- after any label stuck to its front,
 *  as in "Tel:+1…". Anything with letters in it is not. */
const NUMERIC = /^[+(]?[\d().-]*\d[\d().-]*$/;
const numberPart = (text: string) => text.replace(/^[A-Za-z]+[:=]/, '');

/** The Luhn check every card number passes and most other numbers fail. */
export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** A phone number by its shape: nine to fifteen digits, and written like one
 *  -- an international +, separators, or the ten or eleven digits of a
 *  national number. Not a date, a price, a version or an address on a
 *  network, which have digits too. */
function phoneLike(match: string): boolean {
  const digits = match.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return false;
  if ((match.match(/\./g) ?? []).length >= 3) return false;               // 192.168.1.100, 1.2.3.4.5
  if (/^(?:19|20)\d{2}[-.]\d{1,2}[-.]\d{1,2}/.test(match)) return false;   // 2024-10-08 14:30
  return match.startsWith('+') || /[\s().-]/.test(match) || digits.length === 10 || digits.length === 11;
}

/** How unpredictable a string's characters are, in bits each. */
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) { const p = n / text.length; bits -= p * Math.log2(p); }
  return bits;
}

/** A long run that looks generated rather than written: letters of both cases
 *  and digits, and characters as varied as a secret's. A commit hash or a
 *  UUID, all one case, is left alone; so is a word. */
function tokenLike(match: string): boolean {
  return /[a-z]/.test(match) && /[A-Z]/.test(match) && /\d/.test(match) && entropy(match) >= 3.5;
}

/** A line's text as its words make it, and where each word begins and ends in it. */
function spans(line: TextLine): { text: string; words: { word: TextWord; start: number; end: number }[] } {
  const words = line.words.length ? line.words : [line];
  let text = '';
  const placed = words.map(word => {
    if (text) text += ' ';
    const start = text.length;
    text += word.text;
    return { word, start, end: text.length };
  });
  return { text, words: placed };
}

/** The box round the words a match touches, with room for the parts of the
 *  letters a reader's box leaves out. */
function cover(words: TextWord[]): Area {
  const left = Math.min(...words.map(w => w.x)), top = Math.min(...words.map(w => w.y));
  const right = Math.max(...words.map(w => w.x + w.width)), bottom = Math.max(...words.map(w => w.y + w.height));
  const pad = (bottom - top) * 0.18;
  return { x: left - pad, y: top - pad, width: right - left + 2 * pad, height: bottom - top + 2 * pad };
}

/** A card number among some words, or a phone number: digits a card's length
 *  that pass its check first, since a card number is digits a phone pattern
 *  would take too. */
function numberKind(text: string): 'card' | 'phone' | null {
  const digits = text.replace(/\D/g, '');
  if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return 'card';
  return phoneLike(text) ? 'phone' : null;
}

/** Everything sensitive in the words, each with the area to cover, and every
 *  face, left to right along each line. Keys, tokens and addresses are found in
 *  the line's text, and claim their words. Numbers are found among runs of
 *  numeric words -- the longest group of neighbours that makes one, then on
 *  past it -- so a phone number beside a card number is two finds, not one
 *  run too long to be either, and digits inside a word with letters are never
 *  a number at all. */
export function findSensitive(lines: readonly TextLine[], faces: readonly Area[] = []): Sensitive[] {
  const found: Sensitive[] = [];
  for (const line of lines) {
    const { text, words } = spans(line);
    const inLine: Sensitive[] = [];
    const claimed = new Set<number>();
    const take = (kind: SensitiveKind, pattern: RegExp, accept: (match: string) => boolean) => {
      for (const match of text.matchAll(pattern)) {
        const start = match.index ?? 0, end = start + match[0].length;
        const touched = words.flatMap((w, i) => (w.start < end && w.end > start ? [i] : []));
        if (!touched.length || touched.some(i => claimed.has(i)) || !accept(match[0])) continue;
        touched.forEach(i => claimed.add(i));
        inLine.push({ kind, area: cover(touched.map(i => words[i].word)) });
      }
    };
    take('key', KEY, () => true);
    take('email', EMAIL, () => true);
    take('key', TOKEN, tokenLike);
    // Runs of numeric words, unclaimed, side by side.
    const numeric = words.map((w, i) => !claimed.has(i) && NUMERIC.test(numberPart(w.word.text)));
    for (let i = 0; i < words.length;) {
      if (!numeric[i]) { i++; continue; }
      let end = i;
      while (end < words.length && numeric[end]) end++;
      let at = i;
      while (at < end) {
        let taken = 0;
        for (let to = end; to > at; to--) {
          const group = words.slice(at, to).map(w => numberPart(w.word.text)).join(' ');
          const kind = numberKind(group);
          if (kind) { inLine.push({ kind, area: cover(words.slice(at, to).map(w => w.word)) }); taken = to - at; break; }
        }
        at += taken || 1;
      }
      i = end;
    }
    found.push(...inLine.sort((a, b) => a.area.x - b.area.x));
  }
  for (const face of faces) {
    const pad = Math.min(face.width, face.height) * 0.12;
    found.push({ kind: 'face', area: { x: face.x - pad, y: face.y - pad, width: face.width + 2 * pad, height: face.height + 2 * pad } });
  }
  return found;
}

const NAMES: Record<SensitiveKind, [string, string]> = {
  email: ['an email address', 'email addresses'], phone: ['a phone number', 'phone numbers'],
  card: ['a card number', 'card numbers'], key: ['a key', 'keys'], face: ['a face', 'faces'],
};

/** "Hid 2 email addresses and a face." -- what was found, said plainly. */
export function describeHidden(found: readonly Sensitive[]): string {
  const order: SensitiveKind[] = ['email', 'phone', 'card', 'key', 'face'];
  const parts = order.flatMap(kind => {
    const n = found.filter(item => item.kind === kind).length;
    return n === 0 ? [] : [n === 1 ? NAMES[kind][0] : `${n} ${NAMES[kind][1]}`];
  });
  if (!parts.length) return '';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Hid ${list}.`;
}
