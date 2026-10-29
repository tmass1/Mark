export const isTauri = '__TAURI_INTERNALS__' in window;

export interface CapturePreview {
  dataUrl: string; width: number; height: number;
  /** Image pixels per screen point: 2 for a Retina grab, 1 otherwise. */
  scale?: number;
  /** A recording, where this is one: the picture is then its first frame. */
  video?: Video | null;
}
/** A recording as Rust keeps it: its number, the movie, how long it runs in
 *  seconds, and whether it has sound. */
export interface Video { id: number; path: string; duration: number; sound: boolean }

/** A movie Mark keeps, as the page can load it: through Tauri's asset
 *  protocol, which serves only Mark's own recordings. What convertFileSrc
 *  does, without loading the API for it. */
export function videoSource(path: string): string {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc?: (path: string, protocol: string) => string } })
    .__TAURI_INTERNALS__;
  return internals?.convertFileSrc ? internals.convertFileSrc(path, 'asset') : path;
}
/** An AI tool's ask for a screenshot, while one waits: who asked, what they
 *  want to see -- both cleaned by Rust, and shown as text -- and the way in
 *  most likely to get it. */
export interface Asked {
  id: number; client: string; prompt: string; mode: 'region' | 'window' | 'display';
  /** When the tool stops waiting, in milliseconds since 1970, for one that gives up. */
  deadline?: number | null;
}
export interface Snapshot { capture: CapturePreview | null; error: string | null; busy: boolean; request?: Asked | null }

export async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) throw new Error('This action is available in the Mac app.');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(name, args);
}

export async function watchCapture(update: () => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen('capture-changed', update);
}

/** A capture copied straight from the overlay, which the editor never showed:
 *  it fetches them with take_copied, for Recent. */
export async function watchCopied(update: () => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen('capture-copied', update);
}

/** The app menu's Copy and Close. The menu only sees the keys the page leaves
 *  alone, and the page is what can flatten the drawing into the copy, so the
 *  menu asks it to rather than copying the bare capture itself. */
export async function watchMenuCopy(copy: () => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen('copy-and-close', copy);
}

/** The tool that asked stopped waiting before anything was sent. Rust says
 *  which tool, so the editor can say so. */
export async function watchRequestWithdrawn(update: (client: string) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<string>('request-withdrawn', event => update(event.payload));
}

/** What the editor reads of the settings: the ways' shortcuts, and the frame. */
export interface SavedSettings {
  appearance: string; shortcut: string;
  shortcuts?: { window?: string; display?: string; timed?: string; record?: string };
  frame?: unknown;
  /** What follows a capture: the editor, or a thumbnail in the corner. */
  afterCapture?: 'editor' | 'thumbnail';
  /** Whether AI tools may ask for a screenshot. */
  mcp?: boolean;
  /** Whether a recording takes in the microphone, and shows clicks. */
  recordMic?: boolean;
  recordClicks?: boolean;
}

/** Settings change in their own window; the editor shows the shortcuts, so it listens. */
export async function watchSettings(update: (settings: SavedSettings) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<SavedSettings>('settings-changed', event => update(event.payload));
}
