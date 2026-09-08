import { isTauri } from './platform';
import { validEditorSize, type EditorSize } from './model';

const key = 'editorSize';
const browserKey = `mark.${key}`;
export interface Preferences {
  getSize(): Promise<EditorSize | null>;
  setSize(size: EditorSize): Promise<void>;
  onSizeChange(callback: (size: EditorSize | null) => void): Promise<() => void>;
}

// No per-window mirror: every read/write goes to the shared Rust store.
export async function preferences(): Promise<Preferences> {
  if (isTauri) {
    const { load } = await import('@tauri-apps/plugin-store');
    const store = await load('preferences.json', { defaults: {}, autoSave: 100 });
    return {
      getSize: async () => validEditorSize(await store.get(key)),
      setSize: async size => { if (validEditorSize(size)) await store.set(key, size); },
      onSizeChange: callback => store.onKeyChange(key, value => callback(validEditorSize(value))),
    };
  }
  const read = () => {
    try { return validEditorSize(JSON.parse(localStorage.getItem(browserKey) ?? 'null')); }
    catch { return null; }
  };
  return {
    getSize: async () => read(),
    setSize: async size => {
      if (!validEditorSize(size)) return;
      localStorage.setItem(browserKey, JSON.stringify(size));
      window.dispatchEvent(new Event('mark-preferences'));
    },
    onSizeChange: async callback => {
      const local = () => callback(read());
      const remote = (event: StorageEvent) => { if (event.key === browserKey || event.key === null) local(); };
      window.addEventListener('storage', remote);
      window.addEventListener('mark-preferences', local);
      return () => { window.removeEventListener('storage', remote); window.removeEventListener('mark-preferences', local); };
    },
  };
}
