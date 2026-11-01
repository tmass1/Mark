import { describe, expect, it } from 'vitest';
import { friendly } from './update-errors';

const MOVE = "Quit Mark, then open it from your Applications folder (drag it there first if it isn't) and check for updates again. Already there? Drag it out of Applications and back in with Finder, so macOS stops running a temporary copy.";

describe('what a failed update says', () => {
  it("sends a Mark that can't be replaced where it is to Applications", () => {
    // Mark's own words, from before the download.
    expect(friendly("macOS is running a temporary copy of Mark, which can't be updated.")).toBe(MOVE);
    expect(friendly("Mark is running from a disk image or another disk, which can't be updated.")).toBe(MOVE);
    // The system's words, from the move itself.
    // What a user saw from 0.8.2 in Applications, running translocated.
    expect(friendly('Cross-device link (os error 18)')).toBe(MOVE);
    expect(friendly('Read-only file system (os error 30)')).toBe(MOVE);
  });

  it('says when Mark was refused permission to replace itself', () => {
    expect(friendly('Failed to move the new app into place')).toMatch(/wasn't allowed to replace itself/);
    expect(friendly('Permission denied (os error 13)')).toMatch(/wasn't allowed to replace itself/);
  });

  it('still names a connection or signature problem', () => {
    expect(friendly('error sending request for url (https://mark.tommymassaro.com/updates/latest.json)')).toMatch(/couldn't reach/);
    expect(friendly('signature verification failed')).toMatch(/signed by Mark's key/);
  });

  it('falls back to trying again', () => {
    expect(friendly('something nobody expected')).toBe('Something went wrong. Trying again usually fixes it.');
    // Not mistaken for "operation not permitted".
    expect(friendly('os error 12')).toBe('Something went wrong. Trying again usually fixes it.');
  });
});
