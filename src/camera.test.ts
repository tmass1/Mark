import { describe, expect, it } from 'vitest';
import { CAMERA_RATE, RAMP, SHORTEST_ZOOM, addZoom, cameraAt, cameraTrack, merge, moveZoomEdge, suggestZooms } from './camera';

const all = { start: 0, end: 30 };

describe('zooms suggested from clicks', () => {
  it('go round each burst, in before the first click and out after the last', () => {
    // Two clicks a second apart, then one well after.
    const zooms = suggestZooms([[5, 5.1], [6, 6.1], [15, 15.2]], all);
    expect(zooms).toHaveLength(2);
    expect(zooms[0]).toEqual({ start: 4.2, end: expect.closeTo(7.6, 5), scale: 2 });
    expect(zooms[1].start).toBeCloseTo(14.2);
    expect(zooms[1].end).toBeCloseTo(16.7);
  });

  it('stay inside what is kept, merge where they meet, and leave out clicks cut off', () => {
    expect(suggestZooms([[0.2, 0.3]], all)[0].start).toBe(0);
    expect(suggestZooms([[29.5, 29.6]], all)[0].end).toBe(30);
    expect(suggestZooms([[5, 5.1]], { start: 6, end: 30 })).toEqual([]);
    // Clicks under 3 seconds apart are one burst; more, two.
    expect(suggestZooms([[5, 5.1], [8, 8.1]], all)).toHaveLength(1);
    expect(suggestZooms([[5, 5.1], [8.3, 8.4]], all)).toHaveLength(2);
    // Overlapping zooms are one, at the closer level; touching ones stay two.
    expect(merge([{ start: 1, end: 4, scale: 2 }, { start: 3, end: 6, scale: 3 }])).toEqual([{ start: 1, end: 6, scale: 3 }]);
    expect(merge([{ start: 1, end: 4, scale: 2 }, { start: 4, end: 6, scale: 3 }])).toHaveLength(2);
    expect(suggestZooms([], all)).toEqual([]);
  });
});

describe('zooms made and changed by hand', () => {
  it('can be added round the playhead where there is room', () => {
    const zooms = addZoom([], all, 10)!;
    expect(zooms).toEqual([{ start: 9, end: 11, scale: 2 }]);
    // Not inside another, and squeezed between two if it can still go in and out.
    expect(addZoom(zooms, all, 10.5)).toBeNull();
    const between = addZoom([{ start: 4, end: 9, scale: 2 }, { start: 11.5, end: 14, scale: 2 }], all, 10)!;
    expect(between[1]).toEqual({ start: 9, end: 11, scale: 2 });
    expect(addZoom([{ start: 4, end: 9.5, scale: 2 }, { start: 10.5, end: 14, scale: 2 }], all, 10)).toBeNull();
  });

  it('move an edge only as far as their neighbours, and never shorter than in and out', () => {
    const zooms = [{ start: 2, end: 5, scale: 2 }, { start: 8, end: 10, scale: 3 }];
    expect(moveZoomEdge(zooms, all, 0, 'end', 9)[0].end).toBe(8);
    expect(moveZoomEdge(zooms, all, 1, 'start', 9.9)[1].start).toBeCloseTo(10 - SHORTEST_ZOOM);
    expect(moveZoomEdge(zooms, all, 0, 'start', -5)[0].start).toBe(0);
  });
});

describe('the camera', () => {
  const canvas = { width: 1000, height: 600 };
  const zooms = [{ start: 2, end: 6, scale: 2 }];
  // The pointer sits at 700, 300 the whole time.
  const still = Array.from({ length: 300 }, (_, i) => [i / 30, 700, 300] as const);

  it('shows the whole picture outside a zoom, and eases in and out of one', () => {
    expect(cameraAt(1, zooms, still, canvas)).toEqual({ x: 500, y: 300, scale: 1 });
    expect(cameraAt(2, zooms, still, canvas).scale).toBe(1);
    expect(cameraAt(2 + RAMP / 2, zooms, still, canvas).scale).toBeCloseTo(1.5);
    expect(cameraAt(4, zooms, still, canvas).scale).toBe(2);
    expect(cameraAt(6 - RAMP / 4, zooms, still, canvas).scale).toBeLessThan(1.5);
    expect(cameraAt(6, zooms, still, canvas).scale).toBe(1);
  });

  it('centres on where the pointer was, held so the view stays on the picture', () => {
    expect(cameraAt(4, zooms, still, canvas)).toEqual({ x: 700, y: 300, scale: 2 });
    // Near the corner, the view stops at the edge: 2× shows half each way.
    const corner = Array.from({ length: 300 }, (_, i) => [i / 30, 990, 10] as const);
    expect(cameraAt(4, zooms, corner, canvas)).toEqual({ x: 750, y: 150, scale: 2 });
    // A framed recording's points are placed onto the canvas.
    expect(cameraAt(4, zooms, still, canvas, ([x, y]) => [x - 300, y + 10])).toEqual({ x: 400, y: 310, scale: 2 });
  });

  it('glides after the pointer rather than jumping with it', () => {
    const jump = Array.from({ length: 300 }, (_, i) => [i / 30, i / 30 < 4 ? 300 : 700, 300] as const);
    const at = cameraAt(4, zooms, jump, canvas).x;
    expect(at).toBeGreaterThan(300 + 100);
    expect(at).toBeLessThan(700 - 100);
    expect(cameraAt(4.5, zooms, jump, canvas).x).toBe(700);
  });

  it('is sampled for Rust only through the zooms, ending on the whole picture', () => {
    const samples = cameraTrack(zooms, still, canvas);
    expect(samples).toHaveLength(4 * CAMERA_RATE + 1);
    expect(samples[0]).toEqual([2, 500, 300, 1]);
    expect(samples[60]).toEqual([4, 700, 300, 2]);
    expect(samples[samples.length - 1]).toEqual([6, 500, 300, 1]);
    expect(cameraTrack([], still, canvas)).toEqual([]);
  });
});
