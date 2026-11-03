/** A real recording, in a browser: the demo's desktop painted to a canvas many
 *  times a second and written to a movie by the browser's own MediaRecorder,
 *  with the arrow and rings drawn in as macOS draws them for the app, and the
 *  pointer and its presses followed as recording.rs follows them -- so the
 *  editor gets just what it gets from the Mac: a movie to play, and where the
 *  pointer went and when the button went down. */
import { recordsArrow, type Look } from '../look';

export interface Take {
  id: number; url: string; blob: Blob; duration: number; sound: boolean;
  width: number; height: number; scale: number; poster: string; thumbs: string[];
  track: [number, number, number][]; presses: [number, number][]; look: Look; zoom: boolean;
}
export interface Area { x: number; y: number; width: number; height: number }
export interface Setup {
  id: number; area: Area; scale: number; look: Look; zoom: boolean; microphone: MediaStream | null;
  /** The desktop under what is recorded, on a canvas of the movie's size. */
  paint(context: CanvasRenderingContext2D, width: number, height: number): void;
  /** Where the pointer is, in the desktop's points, if it is known. */
  pointer(): [number, number] | null;
}

/** What the browser can write: an MP4 where it can, as the app's are. */
export function movieType(sound: boolean): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const types = sound ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
                      : ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  return types.find(type => MediaRecorder.isTypeSupported(type)) ?? null;
}
export const canRecord = () => movieType(false) !== null && typeof HTMLCanvasElement.prototype.captureStream === 'function';

/** Pixels per point of the movie: the desktop's own, within what a browser
 *  writes smoothly. */
export function movieScale(area: Area, desktop: number): number {
  return Math.min(desktop, 1920 / area.width, 1200 / area.height);
}
/** In even pixels, as H.264 wants. */
const even = (side: number) => Math.max(16, Math.round(side / 2) * 2);

const RATE = 30;
const THUMB_EVERY = 0.5, THUMB_HEIGHT = 144;
/** The Mac's arrow, as look.ts draws it, its tip the point it points with. */
const ARROW = new Path2D('M6.4 3.6v11.6l3.1-2.9 2 4.3 1.8-.8-2-4.3 4.3-.2z');
const RING = 15, RING_FADE = 0.3;

export class Recording {
  private canvas = document.createElement('canvas');
  private context: CanvasRenderingContext2D;
  private recorder: MediaRecorder;
  private parts: Blob[] = [];
  private stopped: Promise<void>;
  private began = 0;
  private lastThumb = -Infinity;
  private timer = 0;
  private poster = '';
  private thumbs: string[] = [];
  private track: [number, number, number][] = [];
  private presses: [number, number | null][] = [];
  private thumbCanvas = document.createElement('canvas');
  readonly width: number;
  readonly height: number;
  readonly type: string;

  constructor(private setup: Setup) {
    const { area, scale, microphone } = setup;
    this.width = even(area.width * scale); this.height = even(area.height * scale);
    this.canvas.width = this.width; this.canvas.height = this.height;
    this.context = this.canvas.getContext('2d', { alpha: false })!;
    this.thumbCanvas.height = THUMB_HEIGHT;
    this.thumbCanvas.width = Math.max(1, Math.round(THUMB_HEIGHT * this.width / this.height));
    const type = movieType(!!microphone);
    if (!type) throw 'This browser can’t record a video.';
    this.type = type;
    this.draw(0);
    this.poster = this.canvas.toDataURL('image/png');
    const stream = this.canvas.captureStream(RATE);
    for (const track of microphone?.getAudioTracks() ?? []) stream.addTrack(track);
    this.recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 20_000_000 });
    this.recorder.ondataavailable = event => { if (event.data.size) this.parts.push(event.data); };
    this.stopped = new Promise(resolve => { this.recorder.onstop = () => resolve(); });
  }

  start() {
    this.recorder.start();
    this.began = performance.now();
    this.timer = window.setInterval(() => this.draw(this.elapsed()), 1000 / RATE);
  }
  /** Seconds it has run. */
  elapsed() { return this.began ? (performance.now() - this.began) / 1000 : 0; }

  /** The button going down or coming up, on the recording's clock. */
  press(down: boolean) {
    const at = this.elapsed();
    if (down) this.presses.push([at, null]);
    else { const open = this.presses.find(press => press[1] === null); if (open) open[1] = at; }
  }

  private draw(time: number) {
    const { area, scale, look, pointer, paint } = this.setup;
    const context = this.context;
    paint(context, this.width, this.height);
    const at = pointer();
    const x = at ? (at[0] - area.x) * (this.width / area.width) : 0, y = at ? (at[1] - area.y) * (this.height / area.height) : 0;
    if (at) this.track.push([time, x, y]);
    if (look.clicks === 'rings') this.drawRings(time, scale);
    if (at && recordsArrow(look.pointer)) {
      context.save();
      context.translate(x, y); context.scale(scale * 1.25, scale * 1.25); context.translate(-6.4, -3.6);
      context.lineJoin = 'round'; context.lineWidth = 1.5; context.strokeStyle = '#fff'; context.fillStyle = '#000';
      context.shadowColor = '#00000059'; context.shadowBlur = 3 * scale; context.shadowOffsetY = scale;
      context.stroke(ARROW);
      context.shadowColor = 'transparent';
      context.fill(ARROW);
      context.restore();
    }
    if (time - this.lastThumb >= THUMB_EVERY) {
      this.lastThumb = time;
      this.thumbCanvas.getContext('2d')!.drawImage(this.canvas, 0, 0, this.thumbCanvas.width, this.thumbCanvas.height);
      this.thumbs.push(this.thumbCanvas.toDataURL('image/jpeg', 0.7));
    }
  }

  /** macOS's rings: a ring round the pointer while the button is down, fading after. */
  private drawRings(time: number, scale: number) {
    const { area } = this.setup;
    const k = this.width / area.width, context = this.context;
    for (const [down, up] of this.presses) {
      const gone = up === null ? 0 : (time - up) / RING_FADE;
      if (gone >= 1 || down > time) continue;
      const near = this.track.find(sample => sample[0] >= down);
      if (!near) continue;
      context.save();
      context.globalAlpha = 1 - gone;
      context.lineWidth = 3 * scale; context.strokeStyle = '#00000066';
      context.beginPath(); context.arc(near[1], near[2], RING * k, 0, Math.PI * 2); context.stroke();
      context.restore();
    }
  }

  /** Ended, kept or thrown away: the take, or null. */
  async stop(keep: boolean): Promise<Take | null> {
    clearInterval(this.timer);
    const end = this.elapsed();
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    await this.stopped;
    for (const track of this.setup.microphone?.getTracks() ?? []) track.stop();
    if (!keep) return null;
    const blob = new Blob(this.parts, { type: this.type.split(';')[0] });
    const url = URL.createObjectURL(blob);
    return {
      id: this.setup.id, url, blob, duration: await lengthOf(url, end), sound: !!this.setup.microphone,
      width: this.width, height: this.height, scale: this.width / this.setup.area.width,
      poster: this.poster, thumbs: this.thumbs, track: this.track,
      // A press still down as it stopped ends there.
      presses: this.presses.map(([down, up]) => [down, up ?? end]), look: this.setup.look, zoom: this.setup.zoom,
    };
  }
}

/** How long the browser says the movie runs; some don't know until asked to
 *  go past its end. As long as it ran, if it won't say. */
function lengthOf(url: string, ran: number): Promise<number> {
  return new Promise(resolve => {
    const video = document.createElement('video');
    video.muted = true; video.preload = 'auto';
    const done = (value: number) => { video.removeAttribute('src'); video.load(); clearTimeout(limit); resolve(value > 0 ? value : ran); };
    const limit = window.setTimeout(() => done(ran), 2000);
    video.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(video.duration)) done(video.duration);
      else { video.addEventListener('durationchange', () => { if (Number.isFinite(video.duration)) done(video.duration); }); video.currentTime = 1e7; }
    });
    video.src = url;
  });
}
