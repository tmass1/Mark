/** A GIF that loops, written by hand, for the demo's Save as GIF: one palette
 *  worked out from a few of its frames, and each frame only what changed since the
 *  last, since most of a recording of a screen holds still. */

const TRANSPARENT = 255;

/** Up to 255 colours for what `samples` show: their colours, a few bits short,
 *  cut in two along the widest side until there are enough. */
export function paletteOf(samples: readonly Uint8ClampedArray[]): Uint8Array {
  const counts = new Map<number, number>();
  for (const pixels of samples) {
    for (let i = 0; i < pixels.length; i += 16) {
      const key = ((pixels[i] >> 3) << 10) | ((pixels[i + 1] >> 3) << 5) | (pixels[i + 2] >> 3);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  type Box = { keys: number[] };
  const channel = (key: number, side: number) => (key >> (10 - 5 * side)) & 31;
  const reach = (box: Box, side: number) => {
    let low = 31, high = 0;
    for (const key of box.keys) { const value = channel(key, side); if (value < low) low = value; if (value > high) high = value; }
    return high - low;
  };
  const boxes: Box[] = [{ keys: [...counts.keys()] }];
  while (boxes.length < 255) {
    let best = -1, bestScore = 0, side = 0;
    boxes.forEach((box, index) => {
      if (box.keys.length < 2) return;
      for (let s = 0; s < 3; s++) {
        const score = reach(box, s) * Math.log2(box.keys.reduce((sum, key) => sum + counts.get(key)!, 0) + 1);
        if (score > bestScore) { bestScore = score; best = index; side = s; }
      }
    });
    if (best < 0) break;
    const box = boxes[best], sorted = [...box.keys].sort((a, b) => channel(a, side) - channel(b, side));
    const half = box.keys.reduce((sum, key) => sum + counts.get(key)!, 0) / 2;
    let seen = 0, cut = 1;
    for (let i = 0; i < sorted.length - 1; i++) { seen += counts.get(sorted[i])!; if (seen >= half) { cut = i + 1; break; } }
    boxes.splice(best, 1, { keys: sorted.slice(0, cut) }, { keys: sorted.slice(cut) });
  }
  const palette = new Uint8Array(256 * 3);
  boxes.forEach((box, index) => {
    let total = 0, r = 0, g = 0, b = 0;
    for (const key of box.keys) {
      const count = counts.get(key)!;
      total += count;
      r += count * (channel(key, 0) * 8 + 4); g += count * (channel(key, 1) * 8 + 4); b += count * (channel(key, 2) * 8 + 4);
    }
    palette.set([Math.round(r / (total || 1)), Math.round(g / (total || 1)), Math.round(b / (total || 1))], index * 3);
  });
  return palette;
}

/** GIF's LZW, 8 bits a pixel, packed into its sub-blocks. */
function lzw(indices: Uint8Array, out: number[]) {
  const CLEAR = 256, END = 257, LIMIT = 4096, SLOTS = 5003;
  const keys = new Int32Array(SLOTS), codes = new Int32Array(SLOTS);
  let width = 9, next = END + 1, bits = 0, length = 0;
  const block: number[] = [];
  const flush = () => { if (block.length) { out.push(block.length, ...block); block.length = 0; } };
  const write = (code: number) => {
    bits |= code << length; length += width;
    while (length >= 8) { block.push(bits & 255); bits >>>= 8; length -= 8; if (block.length === 255) flush(); }
  };
  const reset = () => { keys.fill(-1); next = END + 1; width = 9; };
  out.push(8);
  reset(); write(CLEAR);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const pixel = indices[i], key = (prefix << 8) | pixel;
    let slot = ((pixel << 4) ^ prefix) % SLOTS, found = -1;
    while (keys[slot] !== -1) {
      if (keys[slot] === key) { found = codes[slot]; break; }
      slot = (slot + 1) % SLOTS;
    }
    if (found >= 0) { prefix = found; continue; }
    write(prefix);
    if (next < LIMIT) {
      keys[slot] = key; codes[slot] = next;
      if (next === 1 << width && width < 12) width++;
      next++;
    } else { write(CLEAR); reset(); }
    prefix = pixel;
  }
  write(prefix);
  write(END);
  if (length > 0) block.push(bits & 255);
  flush();
  out.push(0);
}

export class GifWriter {
  private parts: BlobPart[] = [];
  private lookup = new Int16Array(32768).fill(-1);
  private last: Uint8Array;
  private timeline = 0;
  private written = 0;

  constructor(private width: number, private height: number, private delay: number, private palette: Uint8Array) {
    this.last = new Uint8Array(width * height).fill(TRANSPARENT);
    const u16 = (value: number) => [value & 255, value >> 8];
    this.parts.push(new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...u16(width), ...u16(height), 0xf7, 0, 0,
      ...palette,
      // It loops, for ever.
      0x21, 0xff, 11, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, 3, 1, 0, 0, 0,
    ]));
  }

  private nearest(key: number): number {
    const known = this.lookup[key];
    if (known >= 0) return known;
    const r = ((key >> 10) & 31) * 8 + 4, g = ((key >> 5) & 31) * 8 + 4, b = (key & 31) * 8 + 4;
    let best = 0, least = Infinity;
    for (let i = 0; i < 255; i++) {
      const dr = this.palette[i * 3] - r, dg = this.palette[i * 3 + 1] - g, db = this.palette[i * 3 + 2] - b;
      const distance = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (distance < least) { least = distance; best = i; }
    }
    this.lookup[key] = best;
    return best;
  }

  /** The next frame, RGBA, the GIF's size. */
  add(pixels: Uint8ClampedArray) {
    const { width, height, last } = this;
    let left = width, right = -1, top = height, bottom = -1;
    const next = new Uint8Array(width * height);
    for (let y = 0, at = 0; y < height; y++) {
      for (let x = 0; x < width; x++, at++) {
        const p = at * 4;
        const index = this.nearest(((pixels[p] >> 3) << 10) | ((pixels[p + 1] >> 3) << 5) | (pixels[p + 2] >> 3));
        next[at] = index;
        if (index !== last[at]) {
          if (x < left) left = x; if (x > right) right = x;
          if (y < top) top = y; if (y > bottom) bottom = y;
        }
      }
    }
    // Nothing changed: one clear pixel, so the time still passes.
    if (right < 0) { left = top = right = bottom = 0; }
    const w = right - left + 1, h = bottom - top + 1;
    const change = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const at = (top + y) * width + left + x;
        change[y * w + x] = next[at] === last[at] ? TRANSPARENT : next[at];
      }
    }
    this.last = next;
    // Hundredths of a second, carried over so the whole keeps time.
    this.timeline += this.delay * 100;
    const hundredths = Math.max(2, Math.round(this.timeline - this.written));
    this.written += hundredths;
    const u16 = (value: number) => [value & 255, value >> 8];
    const out: number[] = [
      0x21, 0xf9, 4, 0x05, ...u16(hundredths), TRANSPARENT, 0,      // keep what is under, this index clear
      0x2c, ...u16(left), ...u16(top), ...u16(w), ...u16(h), 0,
    ];
    lzw(change, out);
    this.parts.push(new Uint8Array(out));
  }

  finish(): Blob {
    this.parts.push(new Uint8Array([0x3b]));
    return new Blob(this.parts, { type: 'image/gif' });
  }
}
