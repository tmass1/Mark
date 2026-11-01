/** Plainly, what a failed check or install means and what to do about it. The
 *  updater's own words go underneath, for anyone who needs them; this is the
 *  line a person reads. */
export function friendly(detail: string): string {
  // Mark can only replace itself on this Mac's own disk. Mark says so itself
  // before downloading anything; the system's words for the same thing -- a
  // read-only copy, a move that can't cross disks -- are here for a Mark whose
  // check didn't catch it.
  if (/Applications folder first|AppTranslocation|read-only file system|os error 30|cross-device|os error 18/i.test(detail)) {
    return 'Quit Mark, drag it into your Applications folder, open it from there, then check for updates again.';
  }
  // Mark asked for an administrator's password to replace itself, and didn't get it.
  if (/failed to move the new app into place|permission denied|os error 13|not permitted|os error 1\b/i.test(detail)) {
    return "Mark wasn't allowed to replace itself. Try again and enter your Mac's password when asked, or move Mark to your Applications folder.";
  }
  if (/request|connect|dns|timed? ?out|network|offline/i.test(detail)) return "Mark couldn't reach its update server. Check your connection, then try again.";
  if (/signature/i.test(detail)) return "The download wasn't signed by Mark's key, so it was not installed.";
  return 'Something went wrong. Trying again usually fixes it.';
}
