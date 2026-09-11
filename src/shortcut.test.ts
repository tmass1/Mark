import { describe, expect, it } from 'vitest';
import { DEFAULT_SHORTCUT, codeOf, prettyShortcut, shortcutFromEvent, shortcutProblem } from './shortcut';

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

describe('a key press without a code', () => {
  it('is read from the key for digits and letters', () => {
    expect(codeOf({ code: '', key: '4' })).toBe('Digit4');
    expect(codeOf({ code: '', key: 'm' })).toBe('KeyM');
    expect(codeOf({ code: 'KeyM', key: 'µ' })).toBe('KeyM');   // a real code wins over an Option-altered key
    expect(shortcutFromEvent({ ...press('', { metaKey: true }), key: '4' })).toBe('Super+Digit4');
  });
});

describe('a real KeyboardEvent', () => {
  it('is read through its prototype getters, not spread', () => {
    // Unit tests run without a DOM, so this is what a KeyboardEvent is for
    // this purpose: every property a getter on the prototype, none of them
    // own -- exactly what a spread would lose.
    const real = Object.create({
      get code() { return 'KeyM'; }, get key() { return 'M'; },
      get metaKey() { return true; }, get shiftKey() { return true; }, get ctrlKey() { return false; }, get altKey() { return false; },
    }) as KeyboardEvent;
    expect(Object.keys(real)).toEqual([]);
    expect(shortcutFromEvent(real)).toBe('Shift+Super+KeyM');
  });
});
