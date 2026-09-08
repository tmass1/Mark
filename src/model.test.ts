import { describe, expect, it } from 'vitest';
import { validEditorSize, copyThenDismiss } from './model';

describe('persisted window size', () => {
  it('rejects corrupt or offscreen-sized preferences', () => {
    for (const value of [null, {}, { width: 0, height: 500 }, { width: 900, height: Infinity }, { width: 90000, height: 500 }]) {
      expect(validEditorSize(value)).toBeNull();
    }
    expect(validEditorSize({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
  });
});

describe('copy and close', () => {
  it('does not discard the image when clipboard access fails', async () => {
    let dismissed = false;
    await expect(copyThenDismiss(async () => { throw new Error('Clipboard denied'); }, () => { dismissed = true; })).rejects.toThrow('Clipboard denied');
    expect(dismissed).toBe(false);
  });
  it('dismisses only after the clipboard write completes', async () => {
    const order: string[] = [];
    await copyThenDismiss(async () => { order.push('copied'); }, () => { order.push('dismissed'); });
    expect(order).toEqual(['copied', 'dismissed']);
  });
});
