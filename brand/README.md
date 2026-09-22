# The mark

Mark's icon is a coral arrow pointing down and to the left between two capture
corners, on a charcoal tile, with the arrow echoed behind itself as if caught
mid-stroke: the two halves of what the app does, framing a region and marking
it.

`mark.png` is the artwork, square and edge to edge. Everything else is derived
from it by `scripts/build-icon.mjs`:

- the app icon at every size and the `.icns`, cut to Apple's continuous-corner
  squircle on the system's 824-of-1024 grid, so macOS's own margin is kept;
- `../public/site/mark.png`, the same shape filling its square, which the site
  shows in its bar, its footer, beside the download and as its favicon.

Two places need a shape rather than a picture, and come from `mark-dark.svg`,
the vector drawing of the same arrow: the menu bar glyph, which has to be flat
alpha for macOS to tint it for light, dark and highlighted bars, and
`../src/mark.ts`, the arrow's and the corners' paths, which the editor's empty
state draws in the brand red. `mark-light.svg` is the porcelain version, for
light contexts; nothing derives from it yet.

Replace the artwork, run the script, and everything follows. `mark.png` is
currently 400 x 400, which the largest icon sizes are interpolated up from -- a
1024 export would sharpen them.
