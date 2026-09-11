export const isTauri = '__TAURI_INTERNALS__' in window;

export interface CapturePreview {
  dataUrl: string; width: number; height: number;
  /** Image pixels per screen point: 2 for a Retina grab, 1 otherwise. */
  scale?: number;
}
export interface Snapshot { capture: CapturePreview | null; error: string | null; busy: boolean }

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

/** Settings change in their own window; the editor shows the shortcut, so it listens. */
export async function watchSettings(update: (settings: { appearance: string; shortcut: string }) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<{ appearance: string; shortcut: string }>('settings-changed', event => update(event.payload));
}
