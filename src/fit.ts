import { isTauri } from './platform';

/** Keeps a small window -- Settings, Software Update -- exactly as tall as
 *  what it shows, so a message that wraps, or an answer that arrives after the
 *  window opened, grows the window rather than falling off the bottom of it.
 *
 *  Measured as a difference -- what the page needs against what it can see --
 *  and applied to the window's current size, then checked again once the
 *  window has resized, so it lands exactly whatever the title bar does to the
 *  arithmetic: the window's inner size includes the strip under the title bar,
 *  and the page does not. One fit runs at a time; a change that arrives during
 *  one is measured again when it finishes, rather than racing it with a stale
 *  reading of the window's height. */
export function fitWindowTo(root: HTMLElement): void {
  if (!isTauri) return;
  let fitting = false;
  let again = false;
  const fit = async () => {
    if (fitting) { again = true; return; }
    fitting = true;
    try {
      do {
        again = false;
        const shortfall = Math.ceil(root.getBoundingClientRect().height) - window.innerHeight;
        if (Math.abs(shortfall) < 1) break;
        const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window');
        const current = getCurrentWindow();
        const size = (await current.innerSize()).toLogical(await current.scaleFactor());
        await current.setSize(new LogicalSize(size.width, size.height + shortfall));
      } while (again);
    } catch {
      // A window that cannot be measured keeps the size it opened at.
    } finally {
      fitting = false;
    }
  };
  new ResizeObserver(() => { void fit(); }).observe(root);
  window.addEventListener('resize', () => { void fit(); });
}
