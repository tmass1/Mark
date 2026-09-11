/** A stand-in for Tauri's bridge, for the web demo.
 *
 *  Each of Mark's pages -- the editor, the selection overlay, settings -- loads
 *  in its own frame with this installed before any of its own code runs, so
 *  isTauri is true and the real native code path executes: the same invoke
 *  calls, the same events, the same window plumbing. Every command is handed to
 *  the page that hosts the frames, which plays the part of lib.rs. Nothing in
 *  Mark is forked for the demo; only who answers changes. */

export interface DemoHost {
  /** Answer a command from one of the frames, as Rust would. */
  invoke(command: string, args: Record<string, unknown>, from: Window, label: string): Promise<unknown>;
  /** A mousedown on a title area: Tauri's injected script would start a native drag. */
  beginDrag?(label: string, screenX: number, screenY: number): void;
  /** A mouseup anywhere, in case the drag's own ended inside a frame. */
  endDrag?(): void;
  /** A key chord that may be the capture shortcut; true if it was taken. */
  key?(event: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean;
}
export interface DemoFrame extends Window {
  /** Deliver an event into this frame, as Rust's emit would. */
  __markDemoEmit?: (event: string, payload: unknown) => void;
}

interface Listener { event: string; id: number }

export function installBridge(label: string): DemoHost {
  const host = (window.parent as Window & { __markDemo?: DemoHost }).__markDemo;
  if (!host) throw new Error('Open demo.html; the frames do not run on their own.');
  const callbacks = new Map<number, (payload: unknown) => void>();
  const listeners: Listener[] = [];
  let next = 1;

  (window as any).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label }, currentWebview: { label } },
    transformCallback(callback: (payload: unknown) => void) { const id = next++; callbacks.set(id, callback); return id; },
    unregisterCallback(id: number) { callbacks.delete(id); },
    convertFileSrc: (path: string) => path,
    async invoke(command: string, args: Record<string, unknown> = {}) {
      if (command === 'plugin:event|listen') {
        listeners.push({ event: String(args.event), id: Number(args.handler) });
        return args.handler;
      }
      if (command === 'plugin:event|unlisten') {
        const at = listeners.findIndex(l => l.id === args.eventId); if (at >= 0) listeners.splice(at, 1);
        return;
      }
      return host.invoke(command, args, window, label);
    },
  };
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  (window as DemoFrame).__markDemoEmit = (event, payload) => {
    for (const l of [...listeners]) if (l.event === event) callbacks.get(l.id)?.({ event, id: l.id, payload });
  };
  // What Tauri's injected script and the global shortcut would do natively.
  // Tauri drags only when the element pressed is itself the drag region, so a
  // button sitting in a title row is a button, not a handle.
  window.addEventListener('mousedown', e => {
    if (e.button === 0 && (e.target as Element).hasAttribute?.('data-tauri-drag-region')) host.beginDrag?.(label, e.screenX, e.screenY);
  });
  window.addEventListener('mouseup', () => host.endDrag?.());
  if (label === 'editor') window.addEventListener('keydown', e => { if (host.key?.(e)) e.preventDefault(); });
  if (label === 'selector') {
    // An Escape the page heard while the overlay lacked focus arrives as an event; deliver it as the key.
    const emit = (window as DemoFrame).__markDemoEmit!;
    (window as DemoFrame).__markDemoEmit = (event, payload) => {
      if (event === 'demo-escape') { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return; }
      emit(event, payload);
    };
  }
  return host;
}
