import { describe, expect, it } from 'vitest';
import { GifWriter, paletteOf } from './gif';

/** A GIF read back as a viewer would, frame by frame, as palette indices. */
function read(bytes: Uint8Array) {
  const text = String.fromCharCode(...bytes.slice(0, 6));
  const width = bytes[6] | bytes[7] << 8, height = bytes[8] | bytes[9] << 8;
  let at = 13 + 768;
  const frames: { left: number; top: number; width: number; height: number; delay: number; pixels: number[] }[] = [];
  let delay = 0, loops = false;
  while (bytes[at] !== 0x3b) {
    if (bytes[at] === 0x21) {
      if (bytes[at + 1] === 0xf9) delay = bytes[at + 4] | bytes[at + 5] << 8;
      if (bytes[at + 1] === 0xff) loops = true;
      at += 2;
      while (bytes[at]) at += bytes[at] + 1;
      at++;
    } else {
      const u16 = (i: number) => bytes[i] | bytes[i + 1] << 8;
      const [left, top, w, h] = [u16(at + 1), u16(at + 3), u16(at + 5), u16(at + 7)];
      at += 10;
      const min = bytes[at++];
      const data: number[] = [];
      while (bytes[at]) { data.push(...bytes.slice(at + 1, at + 1 + bytes[at])); at += bytes[at] + 1; }
      at++;
      frames.push({ left, top, width: w, height: h, delay, pixels: inflate(data, min) });
    }
  }
  return { text, width, height, frames, loops };
}
function inflate(data: number[], min: number): number[] {
  const clear = 1 << min, end = clear + 1;
  let table: number[][] = [], width = min + 1, bits = 0, length = 0, prior: number[] | null = null;
  const reset = () => { table = Array.from({ length: clear }, (_, i) => [i]); table[clear] = []; table[end] = []; width = min + 1; prior = null; };
  reset();
  const out: number[] = [];
  for (const byte of data) {
    bits |= byte << length; length += 8;
    while (length >= width) {
      const code = bits & ((1 << width) - 1);
      bits >>>= width; length -= width;
      if (code === clear) { reset(); continue; }
      if (code === end) return out;
      const entry: number[] = code < table.length ? table[code] : [...prior!, prior![0]];
      out.push(...entry);
      if (prior && table.length < 4096) { table.push([...prior, entry[0]]); if (table.length === 1 << width && width < 12) width++; }
      prior = entry;
    }
  }
  return out;
}
const solid = (width: number, height: number, [r, g, b]: number[]) => {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([r, g, b, 255], i);
  return pixels;
};
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

describe('a GIF', () => {
  it('finds the colours its frames show', () => {
    const palette = paletteOf([solid(8, 8, [250, 10, 10]), solid(8, 8, [10, 10, 250])]);
    const colours = Array.from({ length: 256 }, (_, i) => [...palette.slice(i * 3, i * 3 + 3)]);
    expect(colours.some(([r, g, b]) => r > 230 && g < 30 && b < 30)).toBe(true);
    expect(colours.some(([r, g, b]) => b > 230 && g < 30 && r < 30)).toBe(true);
  });

  it('holds a picture a viewer can read, loops, and keeps time', async () => {
    const red = solid(6, 4, [250, 10, 10]);
    const gif = new GifWriter(6, 4, 1 / 15, paletteOf([red]));
    gif.add(red); gif.add(red); gif.add(red);
    const { text, width, height, frames, loops } = read(await bytesOf(gif.finish()));
    expect(text).toBe('GIF89a');
    expect([width, height]).toEqual([6, 4]);
    expect(loops).toBe(true);
    expect(frames).toHaveLength(3);
    expect(frames[0].pixels).toHaveLength(24);
    expect(new Set(frames[0].pixels).size).toBe(1);
    // A fifteenth of a second is 6.67 hundredths: 7, 7 and 6, so three take twenty.
    expect(frames.reduce((sum, frame) => sum + frame.delay, 0)).toBe(20);
  });

  it('writes only what changed, and nothing where nothing did', async () => {
    const a = solid(40, 30, [240, 240, 240]);
    const b = a.slice();
    for (let y = 10; y < 14; y++) for (let x = 20; x < 25; x++) b.set([250, 10, 10, 255], (y * 40 + x) * 4);
    const gif = new GifWriter(40, 30, 1 / 10, paletteOf([a, b]));
    gif.add(a); gif.add(b); gif.add(b);
    const { frames } = read(await bytesOf(gif.finish()));
    expect([frames[0].width, frames[0].height]).toEqual([40, 30]);
    expect([frames[1].left, frames[1].top, frames[1].width, frames[1].height]).toEqual([20, 10, 5, 4]);
    expect([frames[2].width, frames[2].height]).toEqual([1, 1]);
    expect(frames[2].pixels).toEqual([255]);
  });

  it('survives far more colours and pixels than its table holds', async () => {
    const [width, height] = [300, 200];
    const noise = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < noise.length; i += 4) noise.set([(i * 7) % 256, (i * 13) % 256, (i * 29) % 256, 255], i);
    const gif = new GifWriter(width, height, 1 / 10, paletteOf([noise]));
    gif.add(noise);
    const { frames } = read(await bytesOf(gif.finish()));
    expect(frames[0].pixels).toHaveLength(width * height);
  });
});
