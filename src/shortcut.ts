/** The capture shortcut, in the global-shortcut plugin's notation -- modifiers
 *  and a key code joined by +, e.g. "Super+Alt+Digit4" -- and the two things
 *  the editor does with it: show it the way a Mac prints it, and build one from
 *  a key press in the recorder. */

export const DEFAULT_SHORTCUT = 'Super+Digit4';

/** ⌃ ⌥ ⇧ ⌘ then the key, which is the order macOS prints modifiers. */
export function prettyShortcut(shortcut: string): string {
  const parts = shortcut.split('+');
  const has = (...names: string[]) => parts.some(p => names.includes(p.toLowerCase()));
  const key = parts.find(p => !MODIFIERS.has(p.toLowerCase())) ?? '';
  return (has('control', 'ctrl') ? '⌃' : '') + (has('alt', 'option') ? '⌥' : '') + (has('shift') ? '⇧' : '')
    + (has('super', 'cmd', 'command', 'meta') ? '⌘' : '') + prettyKey(key);
}

const MODIFIERS = new Set(['control', 'ctrl', 'alt', 'option', 'shift', 'super', 'cmd', 'command', 'meta']);

const KEY_NAMES: Record<string, string> = {
  Space: 'Space', Enter: '↩', Tab: '⇥', Escape: '⎋', Backspace: '⌫', Delete: '⌦',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`',
};

function prettyKey(code: string): string {
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Key')) return code.slice(3);
  return KEY_NAMES[code] ?? code;
}

/** Why a key press cannot be the shortcut, or null when it can. A bare key or
 *  Shift alone would fire while typing in every other app, so ⌘, ⌃ or ⌥ is
 *  required; a modifier on its own is the start of a chord, not a shortcut. */
export function shortcutProblem(event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string | null {
  if (/^(Meta|Control|Alt|Shift)(Left|Right)?$/.test(event.code)) return 'Hold the modifiers, then press a key.';
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return 'Include ⌘, ⌃ or ⌥, or it would fire while you type.';
  if (!/^(Key[A-Z]|Digit\d|F\d{1,2}|Space|Enter|Tab|Comma|Period|Slash|Semicolon|Quote|Bracket(Left|Right)|Backslash|Minus|Equal|Backquote|Arrow(Up|Down|Left|Right))$/.test(event.code)) {
    return 'That key can\'t be part of a shortcut.';
  }
  return null;
}

/** The plugin's notation for a key press, or null if shortcutProblem would object. */
export function shortcutFromEvent(event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string | null {
  if (shortcutProblem(event)) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Super');
  parts.push(event.code);
  return parts.join('+');
}
