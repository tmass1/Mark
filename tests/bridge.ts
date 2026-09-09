import { expect, type Page } from '@playwright/test';
import { CAPTURE } from './fixture';

/** Stands in for Tauri's injected bridge.
 *
 *  The point is to run the editor's *real* native path -- isTauri true, the
 *  actual @tauri-apps/api invoke, the actual plugin calls -- and record what
 *  reaches the other side. Nothing here reimplements the app; it only answers
 *  as Rust would, so a wrong command name or a missing argument shows up as a
 *  failing expectation rather than as a feature that quietly does nothing.
 */
export interface Sent { cmd: string; args: Record<string, unknown> }

export async function installBridge(page: Page, snapshot: {
  capture?: { dataUrl: string; width: number; height: number } | null;
  error?: string | null;
  busy?: boolean;
  fails?: Record<string, string>;
} = {}) {
  const state = {
    capture: snapshot.capture === undefined ? CAPTURE : snapshot.capture,
    error: snapshot.error ?? null,
    busy: snapshot.busy ?? false,
    fails: snapshot.fails ?? {},
  };
  await page.addInitScript(([state]) => {
    const sent: Sent[] = [];
    (window as any).__sent = sent;
    let next = 1;
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: (callback: unknown) => { (window as any)[`__cb${++next}`] = callback; return next; },
      unregisterCallback: () => {},
      convertFileSrc: (path: string) => path,
      async invoke(cmd: string, args: Record<string, unknown> = {}) {
        // Plugin traffic is plumbing, not contract; answer it and move on.
        if (cmd.startsWith('plugin:event|')) return next++;
        if (cmd === 'plugin:store|load' || cmd === 'plugin:store|get_store') return next++;
        if (cmd === 'plugin:store|get') return [null, false];
        if (cmd.startsWith('plugin:store|')) return undefined;
        sent.push({ cmd, args });
        if (state.fails[cmd]) throw state.fails[cmd];
        if (cmd === 'current_capture') {
          return { capture: state.capture, error: state.error, busy: state.busy };
        }
        return undefined;
      },
    };
  }, [state] as const);
}

/** Everything the editor has asked Rust to do, in order. */
export function sent(page: Page): Promise<Sent[]> {
  return page.evaluate(() => (window as any).__sent as Sent[]);
}

/** Forget what has been sent so far, so the next assertion is about one action. */
export function clear(page: Page): Promise<void> {
  return page.evaluate(() => { (window as any).__sent.length = 0; });
}

/** Commands are fired and forgotten, behind a dynamic import, so nothing has
 *  reached the bridge by the time a click returns. Wait for it. */
export async function waitFor(page: Page, cmd: string): Promise<Sent> {
  await expect.poll(async () => (await sent(page)).some(call => call.cmd === cmd)).toBe(true);
  return [...(await sent(page))].reverse().find(call => call.cmd === cmd)!;
}
