import { isTauri } from './platform';

/** Keeps a small window -- Settings, Software Update -- exactly as tall as
 *  what it shows, so a message that wraps, or an answer that arrives after the
 *  window opened, grows the window rather than falling off the bottom of it.
 *
 *  The window is sized to what the page needs plus the strip under the title
 *  bar, which the window's inner size includes and the page does not. That
 *  strip is read once, on the first fit, before anything has been resized and
 *  while the two still agree. Every fit after it depends only on what the page
 *  lays out -- never on the page's height mid-resize, which can lag the window
 *  and would have it ask for the same growth twice. One fit runs at a time; a
 *  change that arrives during one is measured again when it finishes.
 *
 *  Returns the fit itself, for a page that has to know when the window fits:
 *  one that opened hidden shows itself only then. */
export function fitWindowTo(root: HTMLElement): () => Promise<void> {
  if (!isTauri) return async () => {};
  let running: Promise<void> | null = null;
  let again = false;
  let frame: { width: number; strip: number } | undefined;
  let asked: number | undefined;
  const run = async () => {
    // A page that has put nothing in yet has nothing to fit: sized to that, a
    // window would only have to be sized again a moment later.
    if (!root.firstElementChild) return;
    try {
      const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window');
      const current = getCurrentWindow();
      if (!frame) {
        const size = (await current.innerSize()).toLogical(await current.scaleFactor());
        frame = { width: size.width, strip: size.height - window.innerHeight };
      }
      do {
        again = false;
        const height = Math.ceil(root.getBoundingClientRect().height) + frame.strip;
        if (Math.abs(height - (asked ?? window.innerHeight + frame.strip)) < 1) continue;
        asked = height;
        await current.setSize(new LogicalSize(frame.width, height));
      } while (again);
    } catch {
      // A window that cannot be measured keeps the size it opened at.
    }
  };
  const fit = (): Promise<void> => {
    if (running) { again = true; return running; }
    // Let go only once the run has finished, even one with nothing to change.
    running = run().finally(() => { running = null; });
    return running;
  };
  new ResizeObserver(() => { void fit(); }).observe(root);
  window.addEventListener('resize', () => { void fit(); });
  return fit;
}
