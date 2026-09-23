# Mark

Mark is a fast, small macOS screenshot utility built with Tauri v2. Press a
global shortcut, drag across a region, mark it up, then copy and close.

Annotation is arrows, lines, freehand, text, numbered steps, boxes, ellipses,
a highlighter, redaction, and a crop. Finished work goes to the clipboard, to a file, or to macOS's share
sheet. There are no accounts, cloud features, or screen recording. The UI uses
the system WKWebView; the native shell is Rust. There is no Xcode project and
no Swift source.

## Requirements

- macOS 13 or newer
- Node.js and pnpm
- Rust 1.85 or newer
- Apple command-line developer tools for linking

Xcode.app can provide the linker, but the Xcode IDE is never opened.

## Develop with hot reload

```sh
pnpm install
pnpm tauri dev
```

`pnpm tauri dev` starts Vite at `http://127.0.0.1:1420` and opens the real
Tauri window. Changes under `src/` update through Vite HMR. Rust changes under
`src-tauri/` rebuild the native process.

For the fastest visual iteration, run the frontend alone:

```sh
pnpm dev
```

Open `http://127.0.0.1:1420`. The browser preview supplies a local sample image
and a file picker. It never calls native commands. Nothing is written to disk
unless you save a file: no preferences, no history, no screenshots.

## Build the app

```sh
pnpm tauri build --bundles app
```

The output is:

```text
src-tauri/target/release/bundle/macos/Mark.app
```

The build is signed with the Apple Development identity named in
`tauri.conf.json`. That matters beyond tidiness: macOS pins a Screen Recording
grant to a binary's designated requirement, and an ad hoc signature puts the
binary's own hash in that requirement, so every rebuild silently invalidated
the permission and Capture Region failed with a request to grant access that
was already granted. Signing with a certificate makes the requirement depend on
the bundle identifier and the certificate instead, so the grant survives
rebuilds. Change `signingIdentity` to a local identity from
`security find-identity -v -p codesigning` when building on another machine.

Distributing Mark to anyone else still needs a Developer ID identity and
notarization; an Apple Development certificate is only good for this Mac.

## Use

1. Launch Mark. The editor opens on its empty state so the launch is visible.
   Mark itself lives in the menu bar and never appears in the Dock. Turn on
   **Open at Login** in that menu to have Mark running after a restart; macOS
   may ask you to approve it under Login Items in System Settings. A login
   start is deliberately silent, while every other launch still opens the
   editor, because a start with no window at all reads as a failed launch.
2. Press **⌘4**, choose **Capture Region** from Mark's menu, or use the
   **Capture** button in the editor's title bar. That button stays put while a
   capture is open, so a second shot does not mean closing the first, and its
   menu offers **Region**, **Whole Screen** — the display the pointer is on,
   grabbed straight away with no overlay — and **Timed Region**, which opens
   the overlay with a five second delay already armed.
3. Grant Screen Recording access when macOS asks. This permission is also used
   for still screenshots; Mark does not capture audio or video.
4. Drag to select a region. Guides run the full width and height of the display
   through the pointer while you aim, so an edge can be lined up with something
   on the far side of the screen; they step aside once the region is settled,
   and come back if you adjust a corner. The selection stays put afterwards: drag inside it
   to move it, drag a corner to resize, or type exact numbers into Width and
   Height. The link button locks the ratio and ⌘A takes the whole display.
   Press **Capture** to shoot, or the clock first to arm a 3, 5, or 10 second
   delay. A delayed shot clears the screen immediately so you can open the menu
   or hover state you are capturing, and counts down in the menu bar rather
   than over the shot. Escape cancels.
5. Pick a tool in the toolbar.
   - **Arrow**: drag. Drag its body to move it, or either end to reshape it.
     Three styles sit beside the colours: **tapered**, which narrows almost to a
     point at the tail; **solid**, one width throughout; and **thin**, a stroked
     shaft and two wings that does not cover what it points at. Each style's
     button is drawn from the geometry it draws with, so the picker cannot come
     to misrepresent what it picks — and so is the pointer, which carries a
     small copy of the arrow in the colour in hand, since that is the question
     the toolbar cannot answer while you are looking at the image. The
     crosshair stays, because the tail lands exactly where you press.
   - **Line**: drag. The same two ends as an arrow, without the head, so it
     moves and reshapes the same way.

     Hold **shift** while drawing or reshaping either, or a step's arrow, and
     the end snaps to the nearest eighth of a turn — exactly horizontal,
     vertical or square to the corner, in the numbers and not only to the eye.
     The pointer is projected onto that line rather than the length being kept
     and swung round, so locked horizontal, moving the pointer down does not
     quietly lengthen what you are drawing.
   - **Pen**: drag to scribble. The stroke is smoothed through the midpoints of
     what the pointer reported, and thinned once on release rather than while
     you draw — a stroke that simplifies under the pointer visibly changes
     shape as you make it.
   - **Text**: click, then type. Enter starts a new line and Escape finishes.
     Click a note to move it; click it again to edit it.
   - **Step**: click to drop the next number in a filled badge — 1, then 2,
     then 3 — so a screenshot can be talked about rather than described: "1. do
     this, 2. do that" instead of "the circle in the middle just below the nav".
     Drag instead of clicking and the badge stays where you pressed with an
     arrow to where you let go, which is one gesture for a numbered arrow. That
     arrow is an arrow like any other: the three styles beside the colours
     apply to it, and selecting a step adopts its style the way selecting an
     arrow does.

     A badge's number is its place in the sequence rather than something written
     on it, so deleting one closes the gap and the numbers are always 1 to n
     with nothing missing. The order is the order they were drawn, which makes
     ⌘[ and ⌘] — already how everything is reordered — the way to renumber a
     sequence built out of order. The numeral is white, or dark on the paler
     colours where white would not carry.

     The pointer is a miniature of what a drag makes: the badge with its arrow
     leaving it, in the colour and the arrow style in hand, bearing the number
     coming next — all three answered where you are looking rather than up in
     the toolbar.

     A badge dropped with a click still offers a grip beside it, so it can be
     given an arrow afterwards rather than the gesture deciding for good;
     pulling that head back onto the badge takes the arrow off again.

     Every numbered mark gets a row in a panel over the capture, opened on the
     one just made, where you type what it means. **Copy list** (⌘⇧L) puts
     `1. make the nav sticky` and the rest on the clipboard as plain text. The
     A note field owns the keys that edit text — ⌘A, ⌘C, ⌘V, ⌘X and Escape — so
     they do not reach the drawing underneath. ⌘Z is the exception: an empty
     field has no typing to undo, and one Mark focused itself the instant a mark
     was made is where the reflex to take that mark back arrives, so there it
     undoes the mark. With something typed in it, it undoes the typing.

     The panel is a popover: pressing anything else puts it away, and **Steps**
     in the footer, which keeps the count, brings it back. Its title row is the
     handle — drag it off whatever it is covering, and near a side of the
     capture it clings to that side; moved by hand it stays where it was put,
     since the flip between above and below the mark is Mark guessing and a
     guess should not overrule a decision. The chevron folds it to its title
     and the × closes it, its sides take hold of its width, and it is
     translucent, so what it covers still shows through.

     **Write on the image**, in that panel, draws each note beside its badge in
     the Text tool's own size and the mark's colour — for a screenshot going to
     a person rather than a prompt. On or off, what is copied is what is on
     screen.

     Left alone the words are not drawn on the image, which is the point: text
     in a picture has to be read back out of it, while text in a message is
     read as it stands. So the image carries cheap numerals and the message carries
     the words, and Mark renumbers the list when a mark is deleted rather than
     you doing it. The image and the list are two copies because they have to
     be — one clipboard write cannot be pasted as the picture and then as the
     words, since the second paste would only repeat the first.
   - **Box** and **Ellipse**: drag out an outline. Grab the outline to move it,
     or a corner to resize. **Number them**, beside the fill picker, gives each
     one a badge at its corner, in the same sequence the Step tool uses — so
     circling four things numbers them 1 to 4 whether they are circles, badges
     or numbered arrows.
   - **Highlighter**: drag a band of translucent ink over what matters.
   - **Crop**: drag out what to keep. Everything else dims, corners adjust the
     region, and Enter or the Crop button trims to it. The drawing comes along,
     shifted to match, so cropping never quietly discards work; ⌘Z puts the
     capture back.
   - **Redact**: drag over anything that must not leave the machine. The region
     is replaced with coarse blocks averaged from the capture, and the size
     control sets how coarse. This is pixelation rather than blur on purpose:
     a blur can be partly undone and still leaks the shape of what is under it.

   Shift-click gathers several annotations, and ⌘A takes the lot; they then
   move, restyle and delete together. The toolbar says what is selected, so a
   colour or size change never lands somewhere unannounced.

   Annotations stack in the order they were drawn, which a highlighter band
   will happily bury something under. ⌘[ and ⌘] step the selection back and
   forward, ⌘⇧[ and ⌘⇧] send it all the way, and the two buttons beside Delete
   do the same.

   Return does nothing on its own. macOS would have it fire the default button,
   and it used to, which meant a stray Return copied and closed the capture —
   surprising in an editor you type in, and a real loss when what it closed
   took work. Where the crop bar offers **Crop ⏎** it still does that.

   Anything already drawn shows a move pointer, whatever tool is in hand, since
   pressing one selects it rather than drawing over it. Cropping is the
   exception, where a press really does start a crop.

   Tooltips are Mark's own rather than the system's, which cannot be styled and
   appear on no schedule worth having — a long wait for the first and none at
   all for the rest. These wait about four tenths of a second, and once one is
   up the next is all but immediate, since hesitating again between neighbouring
   buttons is what makes tooltips feel slow. They sit beside a rail tool, where
   there is no room above or below, and under everything else unless that would
   fall off the bottom.

   Color and size come from the toolbar and drive every tool. Selecting an
   annotation adopts its style, so the toolbar always describes the next edit.
   ⌘Z undoes, ⌫ deletes the selection, and Escape backs out one level: first
   the text caret, then the selection, then the editor. ⌘W hides Mark and ⌘Q
   quits it, since an accessory app has no menu bar to quit from.

   ⌘Z takes the most recent thing back, whichever kind it was: a crop counts as
   most recent only while nothing has been drawn since it.

   With something selected, ⌘C takes that annotation and ⌘V drops a copy
   nearby; pasting again cascades instead of stacking. ⌘D does both at once.
   A copy carries its colour and size, and a pasted or moved redaction
   re-samples wherever it lands rather than carrying its old patch with it.
6. **Copy** (⌘⇧C) writes the image to the clipboard and leaves the capture
   open to keep working on. **Copy and Close** (⌘C) writes it and dismisses the
   editor. Both put a PNG and a TIFF compatibility representation on the macOS
   clipboard, and both act on the image whatever is selected.

   ⌘C only reaches the image when nothing is selected, because with a selection
   it copies that instead. That change of meaning is always announced in the
   status line, and Escape clears the selection to get the image back.

   A capture you did not draw on is copied as the original bytes macOS
   produced; only a drawing is flattened and re-encoded.
7. **Save** (⌘S) asks where to put a PNG, suggesting the name macOS would give
   a screenshot. **Share** (⌘⇧S) hands the image to macOS's own share sheet —
   Mail, Messages, AirDrop, whatever is installed — and leaves the capture open
   afterwards. Both send the flattened image, so a file is what is on screen,
   crop and annotations included.
8. A capture opens at **100%**, meaning the size it was on screen. That is not
   the same as one screen pixel per image pixel: a Retina grab has twice the
   pixels of the region it came from, so a literal 1:1 view would show every
   screenshot at double the size it was taken. Rust reports each capture's
   density — its pixel count divided by the region asked for — and the zoom
   stops are multiples of that. A capture too large to show whole opens fitted
   instead, since arriving already scrolled is a worse first sight.

   **Fit** and the percentages are in the footer; ⌘+ and ⌘- step through the
   stops, ⌘0 fits and ⌘1 returns to 100%. Drawing works the same at any zoom,
   because annotations are stored in image pixels rather than screen ones.
9. A closed capture is not gone. **Recent** on the empty state holds the last
   six, drawing and all, so closing one by accident costs a click rather than
   the shot. It lives in memory only and does not survive quitting Mark:
   it is an undo for closing, not a library.

Escape, ⌘W, or the red traffic-light button closes without copying. Starting a
new capture hides the old editor; cancel restores it and success replaces it.

## The mark

Mark's icon is a coral arrow pointing down and to the left between two capture
corners, on a charcoal tile, with the arrow echoed behind itself as if caught
mid-stroke: the two halves of what the app does, framing a region and marking
it.

The artwork is `brand/mark.png`, square and edge to edge, and
`scripts/build-icon.mjs` derives everything else from it: the app icon at every
size and the `.icns`, cut to Apple's continuous-corner squircle on the system's
824-of-1024 grid, so the margin macOS expects for shadow and alignment is kept;
and `public/brand/mark.png`, the same shape filling its square, which the
editor's empty state shows on launch and the site shows in its bar, its footer,
beside the download and as its favicon.

One place needs a shape rather than a picture, and comes from
`brand/mark-dark.svg`, the vector drawing of the same arrow: the menu bar glyph,
which has to be flat alpha for macOS to tint it for light, dark and highlighted
bars. The empty state used to be redrawn from paths too, which is exactly how it
came to be showing a different picture from the Dock; it is the icon itself now.
So what greets you on launch, what sits in the Dock and what the site shows stay
one identity: change the artwork, run the script, and they all follow.

Red is the brand; blue stays the system accent for controls. Identity and
interface should not compete, and the red is the colour Mark draws with by
default anyway.

## Architecture

- `src/` is framework-free TypeScript, HTML, and CSS for the editor.
- `src/selector.ts` and `src/region.ts` are the selection overlay: one
  transparent, borderless window per display, lifted above the menu bar and the
  Dock, reporting its rectangle in the global point space that
  `screencapture -R` reads. macOS's own picker is not used; it returns an image
  and nothing else, so it cannot hold a selection open for resizing, exact
  sizing, or a delayed shutter.
- `src/main.ts` keeps the recent captures, with each entry holding the image,
  a thumbnail drawn with its annotations, and the annotations themselves, so a
  restored capture comes back as it was left. Rust no longer holds a restored
  capture, so copying one goes through the flatten path; `copy_edited`
  deliberately does not require a live session capture, and validates the bytes
  it is given instead.
- `src/annotations.ts` owns arrow geometry, text notes, rectangle shapes, the
  SVG overlay, and hit-testing. Redaction samples the capture itself, averaging
  each block down and drawing it back with smoothing off, so the detail is gone
  from the pixels rather than hidden behind them; the patch is rebuilt when a
  region settles rather than on every frame of a drag, and the region stays
  covered by a solid block in the meantime. Coordinates are image pixels, never screen pixels, so a drawing
  survives a resize and composites at full resolution. One routine paints each
  shape to SVG for display and to a canvas for export, so the copied image
  matches the screen.
- `src/platform.ts` is the only frontend boundary for native commands.
- `src-tauri/src/capture.rs` owns region capture, PNG validation, cancellation,
  and temporary-file cleanup.
- `src-tauri/src/macos.rs` contains the small AppKit/Core Graphics bridge for
  permissions, clipboard output, focus restoration, overlay window level,
  login-item registration, and the share sheet. Sharing hands over a file, and
  the file has to outlive the call: the sheet is asynchronous and the receiving
  app reads the URL long after the command returns, so its directory is kept in
  the session and dropped only when the next share replaces it. SMAppService is reached through the Objective-C
  runtime rather than a binding crate, and reports `notFound` rather than
  `notRegistered` until the app has been registered once, so status is compared
  against `enabled` rather than tested for absence.
- `src-tauri/src/session.rs` owns the single in-memory capture session.
- `src-tauri/src/lib.rs` wires the tray, shortcut, window, commands, and app
  lifecycle, and sizes the editor to what it is showing: the capture at actual
  size where the screen allows, and a compact window when there is nothing to
  show. Mark does not remember a window size between captures, because a window
  that fits its contents cannot also restore an arbitrary earlier one — and a
  remembered size is arbitrary twice over, too big for the empty state and the
  wrong shape for the next capture.
- `src-tauri/capabilities/editor.json` is the complete per-window API allowlist.

The editor window is transparent and sits on a native `underWindowBackground`
vibrancy material, which macOS 26 draws with its Liquid Glass treatment. The
stylesheet therefore tints that surface rather than painting over it: fills are
translucent, separators are hairlines, and the only opaque thing in the window
is the capture itself, which has to be exact. AppKit's own Liquid Glass API,
`NSGlassEffectView`, is not exposed by Tauri, so the glass here is the system
material rather than that view.

Transparency, both for this window and for the selection overlay, needs Tauri's
`macos-private-api`, which rules out Mac App Store distribution. Mark does not
target it.

The browser preview has no material behind it and paints a plain ground
instead, so it shows the layout faithfully but not the glass.

The selection overlay cannot have the same treatment. It is transparent over
the live desktop, where `backdrop-filter` samples the page rather than what is
behind the window, and a native material there would frost the whole screen and
defeat the selection. Its panel matches the editor's language instead --
the same radii, pills and hairlines -- and stays dark enough to read against
whatever is on screen, as macOS's own screenshot toolbar does.

The frontend never names a path. Saving opens the panel in Rust and writes what
comes back, and the filename it suggests is stripped of separators, leading
dots and anything past 120 characters before it is used, so a suggestion cannot
become a directory. The frontend cannot run shell commands or read arbitrary
files. Native capture calls
`/usr/sbin/screencapture` directly with fixed arguments and a rectangle that is
validated as finite and non-empty before it is used. Temporary output
uses a private unique directory and is deleted on success, cancellation, error,
and quit.

## Put it on another Mac

`./scripts/release.sh` builds a signed, notarized, stapled disk image. It needs
two things that only an Apple account holder can create, and it stops with
instructions if either is missing:

- a **Developer ID Application** certificate. The Apple Development certificate
  Mark builds with signs an app for the machine that built it; Gatekeeper
  rejects it anywhere else.
- notarization credentials, stored once with `notarytool store-credentials`.
  The script passes a keychain profile name, never a password or a key, so
  nothing secret is written here or typed on a command line during a release.

Stapling matters: it attaches the notarization ticket to the image, so it opens
on a Mac that is offline or behind a firewall rather than silently failing the
check.

To try a build on your own machines before any of that, copy `Mark.app` across
directly — over a shared folder, `rsync`, or a USB drive. Gatekeeper only
assesses files that arrive carrying a quarantine flag, which a direct copy does
not set. If you send it a way that does set one, and macOS refuses to open it,
either clear the flag on that machine:

```sh
xattr -dr com.apple.quarantine /Applications/Mark.app
```

or approve it once under System Settings > Privacy & Security > Open Anyway.
Both are fine for your own machines and neither is a substitute for
notarization if Mark ever goes to someone else's.

## The site and the web demo

`demo.html` is Mark running in a browser: the editor, the selection overlay and
settings are the real pages, each in a frame, against a page that plays lib.rs
and a picture of a desktop. `site.html` is the landing page, which frames the
demo and takes its version, shortcut and mark from the app itself. Both are
pages of the same Vite build, so `pnpm dev` serves them at
`http://127.0.0.1:1420/demo.html` and `/site.html`. A copy in the demo shows
the very image that went to the clipboard, in a card at the bottom right, with
a Save button for a browser that refuses the clipboard; below 640 pixels wide
the demo shows a picture of the editor instead, since a phone cannot drive it.
`demo.html?embed` drops the caption and margin for hosting in a frame.

The site's pictures are renders of the demo, not mockups. After a change to the
editor's appearance, redraw them with the dev server running:

```sh
pnpm site:shots            # writes public/site/*.png and *.jpeg
```

To assemble a folder for a static host:

```sh
pnpm site                  # builds, then fills dist-site/
```

`dist-site/index.html` is the landing page, with the demo, their assets, and
`Mark_<version>_universal.dmg` beside it if the disk image has been built; the
download button points at that file name.

## Verify

```sh
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
pnpm exec playwright test
pnpm build
pnpm tauri build --bundles app
```

Browser screenshots are written to `test-results/editor-light.png` and
`test-results/editor-dark.png`. The selection overlay has its own spec, covering
the drag, the size fields, the ratio lock, the whole-display button, and the
timer -- including a delay armed before the overlay opened. Browser tests cover responsive rendering,
clipboard failures, keyboard dismissal, local image loading,
and the annotation lifecycle: drawing, typing, restyling, moving, reopening a
note, deleting, undo, mixing both tools, and that a copied image carries the
annotation at full resolution. Unit tests cover arrow geometry, text layout,
default sizing, shape export geometry, line and freehand stroke geometry,
highlighter blending, redaction coarseness, selection clamping, and locked-ratio resizing. One browser test
copies a redacted capture back out and counts distinct colours in the region,
so redaction is checked for actually destroying the pixels rather than only
looking like it; another moves a redaction onto different content and reads the
patch back, since a stale patch would both mislead and leak the region it was
cut from. Cropping is covered for the trim itself, for carrying the drawing
along, for undo ordering against drawing, and for re-sampling a redaction into
the cropped image's coordinates. Selecting several at once is covered for
gathering, ungathering, moving, restyling and deleting together, and reordering
for both the buttons and the shortcuts. Recent captures are covered for round-tripping a
drawing through a close, for ordering, and for copying something restored after
Rust has forgotten it. Zoom is covered for scaling, for the keyboard, for
resetting on a new capture, and for drawing landing on the same image pixels
whatever the zoom. Rust tests cover PNG preservation and validation,
cancellation/error classification, capture re-entry, child-process
cancellation, and temporary cleanup.

A stand-in for Tauri's bridge (`tests/bridge.ts`) lets the browser tests run the
editor's real native path — `isTauri` true, the real `invoke`, the real plugin
traffic — and assert on what reaches Rust. That covers command names and
arguments, which nothing else does: in the ordinary browser preview capture
falls back to a file picker and copying goes to the web clipboard, so a renamed
command or a dropped argument would only surface in the built app. It covers the
delay surviving the trip to Rust, an untouched capture copying by reference
while a drawing switches to the flattened path, and the overlay reporting its
selection in global points — the display's own origin added, which is what keeps
a second monitor from capturing whatever sits at those coordinates on the first.

Four things no test can reach, because they need a real screen, a real pointer,
or a restart:

1. **Whole Screen** grabs the display the pointer is on, not another one.
2. **Timed Region** opens with the delay already armed, the screen clears at
   once, and the count runs in the menu bar.
3. A selection on a second display captures that display's content.
4. With **Open at Login** on, a restart brings Mark back with no editor window,
   while opening it by hand still shows one.

Beyond those, check the shortcut from another app, screen-access grant and
denial, Copy and Close into Preview, cancellation with an existing editor,
focus restoration, and quit during selection.
