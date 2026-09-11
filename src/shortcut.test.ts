import { describe, expect, it } from 'vitest';
import { DEFAULT_SHORTCUT, prettyShortcut, shortcutFromEvent, shortcutProblem } from './shortcut';

const press = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
  ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe('showing a shortcut', () => {
  it('prints modifiers in the Mac order and strips the code prefixes', () => {
    expect(prettyShortcut(DEFAULT_SHORTCUT)).toBe('⌘4');
    expect(prettyShortcut('Control+Alt+Super+Digit4')).toBe('⌃⌥⌘4');
    expect(prettyShortcut('Super+Shift+KeyM')).toBe('⇧⌘M');
    expect(prettyShortcut('Alt+Space')).toBe('⌥Space');
    expect(prettyShortcut('Super+Comma')).toBe('⌘,');
  });
  it('reads the plugin\'s other spellings of the modifiers', () => {
    expect(prettyShortcut('CmdOrCtrl+KeyA'.replace('CmdOrCtrl', 'Cmd'))).toBe('⌘A');
    expect(prettyShortcut('ctrl+option+F5')).toBe('⌃⌥F5');
  });
});

describe('recording a shortcut', () => {
  it('builds the plugin\'s notation from a key press', () => {
    expect(shortcutFromEvent(press('Digit4', { metaKey: true }))).toBe('Super+Digit4');
    expect(shortcutFromEvent(press('KeyM', { metaKey: true, altKey: true, shiftKey: true }))).toBe('Alt+Shift+Super+KeyM');
    expect(shortcutFromEvent(press('F6', { ctrlKey: true }))).toBe('Control+F6');
  });
  it('refuses anything that would fire while typing in another app', () => {
    expect(shortcutProblem(press('KeyM'))).toMatch(/⌘, ⌃ or ⌥/);
    expect(shortcutProblem(press('KeyM', { shiftKey: true }))).toMatch(/⌘, ⌃ or ⌥/);
    expect(shortcutFromEvent(press('Digit4'))).toBeNull();
  });
  it('waits while only modifiers are down', () => {
    expect(shortcutProblem(press('MetaLeft', { metaKey: true }))).toMatch(/then press a key/);
    expect(shortcutProblem(press('ShiftRight', { shiftKey: true, metaKey: true }))).toMatch(/then press a key/);
  });
  it('rules out keys that are not shortcut material', () => {
    expect(shortcutProblem(press('Escape', { metaKey: true }))).toMatch(/can't be part/);
    expect(shortcutProblem(press('CapsLock', { metaKey: true }))).toMatch(/can't be part/);
  });
});
