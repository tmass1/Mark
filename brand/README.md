# The mark

Mark's identity is a coral glass arrow pointing down and to the left between
two capture corners, on a tile: charcoal in `mark-dark.svg`, porcelain in
`mark-light.svg`. Both are 1024 × 1024 and share one arrow contour.

These two files are the source of every other form of the mark:

- `scripts/build-icon.mjs` renders `mark-dark.svg` into the app icon at every
  size and the `.icns`, cuts the arrow alone out of it as the menu bar glyph
  (alpha only, so macOS can tint it), and writes the arrow's and the corners'
  paths to `src/mark.ts`, which the editor's empty state draws.
- The site shows `mark-dark.svg` directly, in its bar, its footer and beside
  the download, and as its favicon.

Edit the artwork here, run the script, and everything follows. The two files
use the same gradient ids, so never inline both in one document.
