/** Save, Copy and Share of a recording, in a browser: played through the composer
 *  onto a canvas and written out again, as movie.rs does for the app. A movie takes
 *  as long as it runs, since the browser only writes one as it plays; a GIF is made
 *  a frame at a time. All of it as it was made, with nothing drawn, is the movie itself. */
import { lookOf, type Look } from '../look';
import { composer, gifPlan, lengthOf, partsOf, type Marks } from './compose';
import { GifWriter, paletteOf } from './gif';
import { movieType, type Take } from './recorder';

export interface Asked { start: number; end: number; cuts?: [number, number][]; speed?: number; look?: Look; marks?: Marks | null; small?: boolean }

const PATIENCE = 8000;

function player(take: Take): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.playsInline = true; video.preload = 'auto'; video.muted = !take.sound;
    video.style.cssText = 'position:fixed;left:-9999px;width:2px;height:2px;opacity:0';
    document.body.append(video);
    const limit = window.setTimeout(() => reject('The recording couldn’t be read.'), PATIENCE);
    video.addEventListener('loadeddata', () => { clearTimeout(limit); resolve(video); }, { once: true });
    video.addEventListener('error', () => { clearTimeout(limit); reject('The recording couldn’t be read.'); }, { once: true });
    video.src = take.url;
  });
}
const seek = (video: HTMLVideoElement, time: number) => new Promise<void>(resolve => {
  const done = () => { clearTimeout(limit); resolve(); };
  const limit = window.setTimeout(() => { video.removeEventListener('seeked', done); resolve(); }, PATIENCE);
  video.addEventListener('seeked', done, { once: true });
  video.currentTime = time;
});
const unchanged = (take: Take, asked: Asked) => {
  const speed = asked.speed ?? 1, look = lookOf(asked.look ?? take.look);
  const drawsPointer = (look.pointer !== take.look.pointer && look.pointer !== 'arrow' && look.pointer !== 'hidden')
    || look.pointer === 'halo' || look.pointer === 'touch' || (look.clicks === 'ripple' && take.presses.length > 0);
  return !asked.marks && !asked.cuts?.length && speed === 1 && !drawsPointer
    && asked.start <= 0.01 && asked.end >= take.duration - 0.01;
};

/** A movie of what is asked for. */
export async function movieOf(take: Take, asked: Asked): Promise<Blob> {
  if (unchanged(take, asked)) return take.blob;
  const speed = asked.speed ?? 1;
  const parts = partsOf(asked.start, asked.end, asked.cuts ?? []);
  const compose = await composer(take, lookOf(asked.look ?? take.look), asked.marks ?? null);
  const canvas = Object.assign(document.createElement('canvas'), { width: compose.width, height: compose.height });
  const context = canvas.getContext('2d', { alpha: false })!;
  const video = await player(take);
  const type = movieType(take.sound);
  if (!type) throw 'This browser can’t make a video.';
  await seek(video, parts[0].start);
  compose.draw(video, video.currentTime, context, canvas.width, canvas.height);
  const stream = canvas.captureStream(30);
  let audio: AudioContext | null = null;
  if (take.sound) {
    audio = new AudioContext();
    const out = audio.createMediaStreamDestination();
    audio.createMediaElementSource(video).connect(out);
    for (const track of out.stream.getAudioTracks()) stream.addTrack(track);
  }
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 20_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
  recorder.start();
  try {
    video.playbackRate = speed;
    for (const [index, part] of parts.entries()) {
      if (index) { recorder.pause(); await seek(video, part.start); compose.draw(video, video.currentTime, context, canvas.width, canvas.height); recorder.resume(); }
      await video.play();
      await new Promise<void>((resolve, reject) => {
        let seen = video.currentTime, since = performance.now();
        const step = () => {
          const now = video.currentTime;
          compose.draw(video, now, context, canvas.width, canvas.height);
          if (now !== seen) { seen = now; since = performance.now(); }
          if (now >= part.end - 0.01 || video.ended) { video.pause(); resolve(); return; }
          if (performance.now() - since > PATIENCE) { video.pause(); reject('The recording stopped playing.'); return; }
          window.setTimeout(step, 1000 / 60);
        };
        step();
      });
    }
  } finally {
    recorder.stop();
    await stopped;
    void audio?.close();
    video.remove();
  }
  return new Blob(chunks, { type: type.split(';')[0] });
}

/** A GIF that loops, of what is asked for. */
export async function gifOf(take: Take, asked: Asked): Promise<Blob> {
  const speed = asked.speed ?? 1;
  const parts = partsOf(asked.start, asked.end, asked.cuts ?? []);
  const compose = await composer(take, lookOf(asked.look ?? take.look), asked.marks ?? null);
  const plan = gifPlan(parts, speed, [compose.width, compose.height], take.scale, !!asked.small);
  const [width, height] = plan.size;
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!;
  const video = await player(take);
  video.muted = true;
  try {
    // The palette from a few frames through it; the frames then one by one.
    const samples: Uint8ClampedArray[] = [];
    const every = Math.max(1, Math.floor(plan.times.length / 6));
    for (let i = 0; i < plan.times.length; i += every) {
      await seek(video, plan.times[i]);
      compose.draw(video, plan.times[i], context, width, height);
      samples.push(context.getImageData(0, 0, width, height).data);
    }
    const gif = new GifWriter(width, height, plan.delay, paletteOf(samples));
    for (const time of plan.times) {
      await seek(video, time);
      compose.draw(video, time, context, width, height);
      gif.add(context.getImageData(0, 0, width, height).data);
    }
    return gif.finish();
  } finally { video.remove(); }
}
/** How long a movie of what is asked for takes to make, in seconds: as long as it runs. */
export const movieTime = (take: Take, asked: Asked) => (unchanged(take, asked) ? 0 : lengthOf(partsOf(asked.start, asked.end, asked.cuts ?? []), asked.speed ?? 1));
