import { describe, expect, it } from 'vitest';
import { copyThenDismiss } from './model';

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
