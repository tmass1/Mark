import './recording.css';
import { command, isTauri } from './platform';
import { clock } from './trim';

/** The bar beside a recording, and -- as recording.html?outline -- the line
 *  round the part of the screen being recorded. Both are panels that never
 *  take the focus, and both are Mark's, which the recording leaves out. Rust
 *  runs the recording and says each second how long it has run. */

interface Status { elapsed: number; limit: number; mic: boolean }

/** In its last half minute, the bar counts down to where it stops by itself. */
const WARN = 30;

const root = document.querySelector<HTMLDivElement>('#recording')!;

if (new URLSearchParams(location.search).has('outline')) {
  document.documentElement.classList.add('outline');
  root.innerHTML = '<div class="line"></div>';
} else {
  root.innerHTML = `
    <div class="bar" role="toolbar" aria-label="Recording">
      <span class="live" aria-hidden="true"></span>
      <span class="time" role="timer" aria-live="off">0:00</span>
      <svg class="mic" viewBox="0 0 20 20" aria-label="With the microphone" hidden>
        <rect x="7.4" y="2.8" width="5.2" height="9.2" rx="2.6"/><path d="M4.6 9.6a5.4 5.4 0 0 0 10.8 0M10 15v2.4"/></svg>
      <span class="gap"></span>
      <button class="stop" type="button" title="Stop and keep the recording">
        <span class="square" aria-hidden="true"></span>Stop
      </button>
      <button class="discard" type="button" aria-label="Discard the recording" title="Stop and discard the recording">
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.4 3.4l5.2 5.2M8.6 3.4l-5.2 5.2"/></svg>
      </button>
    </div>`;
  const time = root.querySelector<HTMLElement>('.time')!;
  const mic = root.querySelector<SVGElement>('.mic')!;
  const stop = root.querySelector<HTMLButtonElement>('.stop')!;
  const discard = root.querySelector<HTMLButtonElement>('.discard')!;

  const show = (status: Status) => {
    const left = status.limit - status.elapsed;
    time.textContent = left <= WARN ? `${clock(Math.max(0, left))} left` : clock(status.elapsed);
    time.classList.toggle('ending', left <= WARN);
    mic.toggleAttribute('hidden', !status.mic);
  };
  /** One press ends it: a second would find nothing to stop. */
  const end = (how: 'stop_recording' | 'discard_recording') => {
    stop.disabled = discard.disabled = true;
    void command(how).catch(() => { stop.disabled = discard.disabled = false; });
  };
  stop.addEventListener('click', () => end('stop_recording'));
  discard.addEventListener('click', () => end('discard_recording'));

  if (isTauri) {
    void import('@tauri-apps/api/event').then(({ listen }) => listen<Status>('recording-tick', event => {
      // A tick at 0 is a new recording, shown in a bar kept from the last.
      if (event.payload.elapsed === 0) stop.disabled = discard.disabled = false;
      show(event.payload);
    }));
    void command<Status | null>('recording_status').then(status => { if (status) show(status); }).catch(() => {});
  }
}
