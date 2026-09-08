export const isTauri = '__TAURI_INTERNALS__' in window;

export interface CapturePreview { dataUrl: string; width: number; height: number }
export interface Snapshot { capture: CapturePreview | null; error: string | null; busy: boolean }

export async function command<T>(name: string): Promise<T> {
  if (!isTauri) throw new Error('This action is available in the Mac app.');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(name);
}

export async function watchCapture(update: () => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen('capture-changed', update);
}
