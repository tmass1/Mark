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
  /** Canned replies, for commands whose return value the editor acts on. */
  returns?: Record<string, unknown>;
} = {}) {
  const state = {
    capture: snapshot.capture === undefined ? CAPTURE : snapshot.capture,
    error: snapshot.error ?? null,
    busy: snapshot.busy ?? false,
    fails: snapshot.fails ?? {},
    returns: snapshot.returns ?? {},
  };
  await page.addInitScript(([state]) => {
    const sent: Sent[] = [];
    (window as any).__sent = sent;
    let next = 1;
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: (callback: unknown) => { (window as any)[`__cb${++next}`] = callback; return next; },
      unregisterCallback: () => {},
      convertFileSrc: (path: string) => path,
      // Which window this page is, as Tauri tells every page: without it the
      // window API cannot say whom a close or a resize is for.
      metadata: { currentWindow: { label: 'window' }, currentWebview: { windowLabel: 'window', label: 'window' } },
      async invoke(cmd: string, args: Record<string, unknown> = {}) {
        // Plugin traffic is plumbing, not contract; answer it and move on --
        // keeping what is listened for, so a test can play Rust's part.
        if (cmd.startsWith('plugin:event|')) {
          if (cmd === 'plugin:event|listen') ((window as any).__listening ??= []).push(args);
          return next++;
        }
        sent.push({ cmd, args });
        if (state.fails[cmd]) throw state.fails[cmd];
        if (cmd === 'current_capture') {
          return { capture: state.capture, error: state.error, busy: state.busy };
        }
        return cmd in state.returns ? state.returns[cmd] : undefined;
      },
    };
  }, [state] as const);
}

/** Everything the editor has asked Rust to do, in order. */
export function sent(page: Page): Promise<Sent[]> {
  return page.evaluate(() => (window as any).__sent as Sent[]);
}

/** Deliver an event to whatever the page listens for it with, as Rust would emit it. */
export async function emit(page: Page, event: string, payload: unknown = null): Promise<void> {
  await expect.poll(() => page.evaluate(name =>
    ((window as any).__listening ?? []).some((args: { event: string }) => args.event === name), event)).toBe(true);
  await page.evaluate(([name, payload]) => {
    for (const args of (window as any).__listening as { event: string; handler: number }[]) {
      if (args.event === name) (window as any)[`__cb${args.handler}`]({ event: name, id: 0, payload });
    }
  }, [event, payload] as const);
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
