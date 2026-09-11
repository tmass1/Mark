# Mark — Dark Theme Handoff

A reference for reusing Mark's dark look in another app, written for **Headroom**. It documents what the theme *is*, the exact values, the recipes for each surface and control, and the rules that keep it coherent — followed by a prompt you can hand to whoever (or whatever) applies it.

Mark is a macOS screenshot utility built with Tauri: a native window on a macOS vibrancy material, a web view on top, controls drawn in CSS. Its dark palette was lifted from the Fritter dark-mode design (`rgb(27, 33, 42)` slate) and its glass treatment from macOS 26's Liquid Glass. Everything below is taken from the shipping stylesheet, `src/style.css`, as of commit `26059f2`.

---

## 1. The idea

**Glass where you look; transparency where you don't.**

The interface is built as layers, not as one surface with an opacity:

1. **Ground** — the window's material (blurred desktop) under a low-alpha slate scrim. The clearest layer. Nothing to read sits directly on it.
2. **Panes** — floating capsules of frosted glass carrying the controls: a lit top edge, a shadowed underside, a soft drop shadow. Translucent, but frosted just enough to read on.
3. **Floor** — the footer. Not a pane: an edge-to-edge band flush with the bottom, a shade more solid, so it reads as the window's base rather than a fourth floating thing.
4. **Content** — the screenshot. Fully opaque, on a card with a deep shadow. The one thing that must be exact.

Legibility comes from the layering, so the ground can be far clearer than it could be if the controls sat on it directly. The temperature is cool throughout: the slate hue runs through the ground, the floor, and every tint — no neutral greys.

---

## 2. Tokens

Colours are 8-digit hex (`#rrggbbaa`). Alphas matter: nearly every surface is a translucency over the one beneath.

### Dark (the default)

| Token | Value | Role |
|---|---|---|
| `--ink` | `#f3f3f3` | Primary text and active icons |
| `--muted` | `#9ca3af` | Secondary text, inactive icons, labels |
| `--hairline` | `#f3f3f31f` | Dividers, the floor's top rule |
| `--scrim` | `#1b212a5c` | The ground: the slate at ~36% over the material |
| `--panel` | `#dbe3f01f` | A pane's fill: cool white at 12% |
| `--base` | `#1b212ab8` | The floor: the slate at ~72% |
| `--sheen` | `linear-gradient(180deg, #ffffff12, #ffffff00 58%)` | Light caught along a pane's top |
| `--rim` | `#ffffff30` | The lit top edge of a pane or control |
| `--edge` | `#0000006b` | A pane's shadowed underside and outline |
| `--lens` | `#dbe3f033` | The raised pill under an active segment |
| `--control` | `#dbe3f01c` | Button fill |
| `--control-hover` | `#dbe3f030` | Button fill, hovered |
| `--control-line` | `#f3f3f340` | Button border (Fritter's 25% control border) |
| `--sunken` | `#0000004a` | A recessed track (segmented controls, pickers) |
| `--glass` | `#222832f2` | Menus and popovers: Fritter's surface, near-opaque |
| `--blue` | `#0a84ff` | System accent: primary actions, focus, selection |
| `--hover` | `#359aff` | Accent, hovered |
| `--shadow` | `#00000080` | Drop shadows |
| `--frame-rim` | `#ffffff30` | The lit top edge of the window itself |
| `--frame-line` | `#ffffff1a` | The window's glass edge, all the way round |
| `--brand` | `#ff453a` | Mark's identity colour (the arrow). **Do not copy** — see §11 |

The slate ladder these come from, as solid colours: ground `#1b212a`, elevated surface `#222832`, raised control `#293039`. The translucent tokens are those steps expressed as lifts over the layer beneath.

### Light (for completeness)

| Token | Value |
|---|---|
| `--ink` `#1c1c1e` · `--muted` `#5e5e66` · `--hairline` `#00000012` |
| `--scrim` `#ffffff2e` · `--panel` `#ffffff59` · `--base` `#ffffff7a` |
| `--sheen` `linear-gradient(180deg, #ffffff47, #ffffff00 58%)` · `--rim` `#ffffffe0` · `--edge` `#00000016` |
| `--lens` `#fffffff5` · `--control` `#ffffffb8` · `--control-hover` `#ffffffe6` · `--control-line` `#00000018` · `--sunken` `#0000000d` |
| `--glass` `#fbfbfdf2` · `--blue` `#007aff` · `--hover` `#0069dc` · `--shadow` `#0000002e` |
| `--frame-rim` `#ffffffc4` · `--frame-line` `#ffffff73` · `--brand` `#ff3b30` |

---

## 3. Type

```css
font: 13px -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
font-synthesis: none; text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased;
```

| Use | Size | Weight | Notes |
|---|---|---|---|
| Body, controls | 13px | 400 | The base |
| Primary button | 13px | 500 | |
| Title | 20px | 600 | `letter-spacing: -.35px` |
| Window title | 13px | 600 | `letter-spacing: -.1px` |
| Small labels, hints | 11–12px | 400 | `--muted` |
| Section eyebrow | 10px | 400 | `text-transform: uppercase; letter-spacing: .6px`, `--muted` |
| Numbers (sizes, counts) | 11px | 400 | `font-variant-numeric: tabular-nums` |
| Key caps (`kbd`) | 11px | inherit | `opacity: .5; letter-spacing: .3px; margin-left: 9px` |
| Status / error note | 11.5px | 400 | `--brand`-coloured text, `line-height: 1.45` |

Line height 1.5 for prose, 1.45 for notes. No custom fonts.

---

## 4. Surfaces

### Ground
The window background is transparent over a native material (macOS `sidebar` vibrancy, always active), tinted by the scrim, with a lit frame:

```css
#app { background: var(--scrim); border-radius: 12px;
       box-shadow: inset 0 1px 0 var(--frame-rim), inset 0 0 0 .5px var(--frame-line); }
```

**Without a native material** (web, Electron without vibrancy): use the solid slate `#1b212a` as the ground and drop `--scrim` to `#1b212a` at 100%. The layering still reads; you lose the desktop showing through, nothing else.

### Pane
Frosted glass on the ground. Every floating group of controls is one of these.

```css
.pane {
  background: var(--sheen), var(--panel);
  box-shadow: inset 0 1px 0 var(--rim),          /* lit top edge */
              inset 0 -.5px 0 var(--edge),       /* shadowed underside */
              0 0 0 .5px var(--edge),            /* crisp outline */
              0 14px 34px -16px var(--shadow);   /* soft lift */
}
```
Radius: **half the height** for a bar (a capsule); 16–20px for a pane that wraps to several lines. See §6.

### Floor
The footer. Edge to edge, flush with the bottom, square top edge.

```css
footer { height: 60px; padding: 0 14px; background: var(--base);
         border-top: 1px solid var(--hairline); border-radius: 0 0 12px 12px;
         box-shadow: inset 0 1px 0 var(--rim); }
```

### Popover / menu
Near-opaque, with a real backdrop blur because page content sits behind it:

```css
.popover { padding: 5px; border-radius: 12px; background: var(--glass);
           backdrop-filter: blur(24px) saturate(170%);
           box-shadow: 0 12px 34px var(--shadow), 0 0 0 .5px var(--control-line); }
.popover button { padding: 7px 10px; border-radius: 8px; font-size: 12px; }
.popover button:hover { background: var(--blue); color: #fff; }
```

### Content card
The one opaque thing, lifted well clear of the glass:

```css
.card { border-radius: 6px;
        box-shadow: 0 22px 54px -22px #00000066, 0 3px 10px #00000021, 0 0 0 .5px #0000002b; }
```

---

## 5. Controls

All controls are **30px tall pills** (`border-radius: 999px`) unless noted.

**Primary** — the accent, with a glass sheen and a coloured glow:
```css
.primary { height: 30px; padding: 0 16px; border: none; color: #fff; font-weight: 500;
  background: linear-gradient(180deg, #ffffff33, #ffffff00 60%), var(--blue);
  box-shadow: 0 8px 18px -10px #007affb3, 0 1px 2px #0000001f, inset 0 1px 0 #ffffff40; }
.primary:hover { background: linear-gradient(180deg, #ffffff33, #ffffff00 60%), var(--hover); }
.primary:active { transform: translateY(.5px); }
```

**Glassy** — the standard button:
```css
.glassy { height: 30px; padding: 0 14px; border: 1px solid var(--control-line);
  background: var(--control); box-shadow: inset 0 1px 0 var(--rim), 0 1px 2px #00000012; }
.glassy:hover { background: var(--control-hover); }
```
Related actions share one capsule: first child `border-radius: 999px 0 0 999px`, last `0 999px 999px 0`, `border-left: none` on the second.

**Subtle / icon** — no fill until hovered:
```css
.subtle { border: none; padding: 6px 8px; background: transparent; color: var(--muted); font-size: 12px; }
.subtle:hover { background: var(--sunken); color: var(--ink); }
.subtle.icon { display: flex; padding: 5px 6px; }  .subtle.icon svg { width: 18px; height: 18px; }
```
Icons: 20×20 viewBox, `stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"`, drawn at 18px.

**Segmented control + sliding lens** — the signature. A sunken track, plain buttons, and one raised pill that *slides* to the chosen segment rather than a background that appears on it:
```css
.segments { position: relative; display: inline-flex; gap: 2px; padding: 2px; border-radius: 999px;
            background: var(--sunken); box-shadow: inset 0 1px 1px #0000000f; }
.segment  { position: relative; z-index: 1; border: none; border-radius: 999px; padding: 5px 13px;
            background: transparent; color: var(--muted); font-size: 12.5px; transition: color .15s; }
.segment:hover, .segment[aria-checked="true"] { color: var(--ink); }
.lens { position: absolute; top: 0; left: 0; z-index: 0; border-radius: 999px; background: var(--lens);
        box-shadow: inset 0 1px 0 #ffffffb8, 0 1px 3px #00000021, 0 0 0 .5px var(--edge);
        transition: transform .34s cubic-bezier(.22, 1, .36, 1), width .2s, height .2s; pointer-events: none; }
@media (prefers-reduced-motion: reduce) { .lens { transition: none; } }
```
```ts
/** One pill per group, slid under the checked segment. The group is the pill's
 *  offset parent. A pill snaps into its first rendered place and slides only
 *  between two places it has really been -- an unrendered group reports every
 *  offset as zero, and a transition from there is a slide in from the corner. */
function placeLens(group: HTMLElement) {
  let lens = group.querySelector<HTMLElement>(':scope > .lens');
  if (!lens) { lens = document.createElement('span'); lens.className = 'lens'; group.prepend(lens); }
  const active = group.querySelector<HTMLElement>('[aria-checked="true"]');
  const rendered = !!active && active.offsetParent !== null;
  lens.hidden = !rendered;
  if (!active || !rendered) { delete lens.dataset.placed; return; }
  const snap = lens.dataset.placed === undefined;
  if (snap) lens.style.transition = 'none';
  lens.style.width = `${active.offsetWidth}px`;
  lens.style.height = `${active.offsetHeight}px`;
  lens.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
  if (snap) { void lens.offsetWidth; lens.style.transition = ''; lens.dataset.placed = ''; }
}
```
Call it after any change to which segment is checked, and once when the group first appears.

**Swatch / colour bead** — lit from above, resting on a shadow:
```css
.swatch { width: 20px; height: 20px; border: 1px solid #00000029; border-radius: 50%;
  box-shadow: inset 0 1.5px 1px #ffffff66, inset 0 -1px 1px #0000001a, 0 1px 2px #0000001f; }
.swatch.active { box-shadow: inset 0 1.5px 1px #ffffff66, 0 0 0 2px var(--glass), 0 0 0 3.5px var(--blue); }
```

**Key cap / recorder** — a glassy button holding a `kbd`, lit while listening:
```css
.recorder { min-width: 88px; }  .recorder kbd { margin: 0; opacity: 1; font-size: 13px; letter-spacing: .5px; }
.recorder.recording { border-color: var(--blue); box-shadow: 0 0 0 3px #007aff33, inset 0 1px 0 var(--rim); }
```

**Checkbox** — native, `accent-color: var(--blue)`, 15px, label 13px.

**Range slider** — native, `accent-color: var(--blue)`, 88px wide (62px when narrow).

**Focus** — `outline: 2.5px solid var(--blue); outline-offset: 2px` on `:focus-visible` only.

**Disabled** — `opacity: .4`.

---

## 6. Shape

- **Window**: 12px corners.
- **Bars and rails are capsules**: radius = half the height (48px bar → 24; 60px → not a pane, see floor) or half the width (44px rail → 22). A capsule has no corner to disagree with the window's.
- **Concentric rule** for anything nested that is *not* a capsule: `inner radius = outer radius − inset`. A 18px pane set 12px inside a 12px window is wrong at any radius but zero — which is why the panes became capsules.
- **Pills inside panes come out concentric by construction**: 22 − 6 padding = 16 = half a 32px tool; 26 − 11 = 15 = half a 30px button.
- Multi-line panes (messages): 16px. Cards: 20px. Popovers: 12px outer, 8px items. Content card: 6px.

---

## 7. Motion

| What | Values |
|---|---|
| Lens slide | `transform .34s cubic-bezier(.22, 1, .36, 1)`, size `.2s` |
| Colour change on hover/active | `.15s` |
| Press | `transform: translateY(.5px)` on `:active` |
| Reduced motion | all transitions off |

Nothing else animates. Glass should move like glass — one thing, decisively — not everything, a little.

---

## 8. Glass, native and not

On macOS 26 Mark lays real `NSGlassEffectView` panes under the toolbar and rail (refraction, not tint) and draws those panes with no CSS background. The CSS pane recipe in §4 is the fallback for every other platform and it is what this document specifies. If Headroom is a native Mac app, the same split applies: native glass where the platform offers it, the CSS pane where it doesn't, identical geometry for both so nothing shifts.

Web-only approximation of the ground: a solid `#1b212a`, or if there is imagery behind, `backdrop-filter: blur(36px) saturate(1.5)` under the scrim.

---

## 9. Layout numbers (Mark's window, for reference)

Title row 46 · toolbar capsule 48 · gap 10 · content · gap 10 · floor 60. Panes inset 12 from the window edge; rail 44 wide, 10 from the content. Toolbar padding 14 (12 when narrow), gap 14 between groups (10 below 760px, 8 below 560px). Tool buttons 32×32 with 18px icons; 6px pane padding around them.

---

## 10. Rules

1. **Legibility by layering, never by opacity.** If something is hard to read, put it on a pane; do not frost the ground.
2. **Nothing scrolls or shrinks silently.** A control that does not fit is hidden by an explicit breakpoint, in order of what has a keyboard fallback. A hidden-scrollbar overflow container is how Mark lost two tools and a colour swatch without anyone noticing.
3. **The content is opaque.** Everything else may be glass; the thing the user came for is not.
4. **One floor.** Bars and rails float; the footer is the base. Four floating capsules was one too many.
5. **Capsules, not rounded rectangles, near the window's corners.**
6. **Cool throughout.** Every grey carries the slate hue. If a colour was picked by eye and looks neutral, it is wrong.
7. **Measure, don't eyeball, breakpoints** — with the widest real state on screen, in the real stylesheet.
8. **Motion is one gesture.** The lens slides. Nothing else needs to.

---

## 11. Adapting to Headroom

**Keep:** the slate ladder, text colours, pane/floor/control recipes, shape rules, the lens, the type scale, `--blue` as the system accent.

**Replace:** `--brand`. `#ff453a` is Mark's identity — the colour it draws with. Headroom's brand colour goes here and should be used the same way: for identity and emphasis, never for controls (that is what `--blue` is for). Keep the two from competing.

**Decide:**
- **Platform.** Native Mac → materials and glass as in §8. Web → solid slate ground, CSS panes, no vibrancy.
- **Light mode.** Mark's light tokens are in §2; Mark defaults to dark with Light and Match System as settings. Headroom can do the same or ship dark only.
- **Density.** Mark is a tool palette: 13px body, 30px controls. A usage dashboard with charts and tables may want the same tokens at a slightly larger body size; keep the ratios.
- **Data colours.** Mark has none. Charts need a categorical palette that reads on `#1b212a`; build it in the same cool temperature and test each against `--ink` and the ground, not against white.

---

## 12. Handoff prompt

Copy from here down into the conversation that will do the work.

```
You are applying an existing dark theme to Headroom, an AI-usage app. The theme
comes from Mark, a macOS screenshot utility, and is fully specified in the
attached document "Mark — Dark Theme Handoff". Treat that document as the source
of truth for colour, type, surface recipes, shape rules and motion. Do not invent
values that are in it; do not skip rules that are in it.

Before writing any styles:
1. Inventory Headroom's stack -- framework, styling system (CSS variables,
   Tailwind, CSS-in-JS, native), whether it runs on the web, in Electron/Tauri,
   or natively on macOS -- and its existing design tokens and components. Reuse
   what exists; map Mark's tokens onto Headroom's token system rather than
   creating a parallel one.
2. Tell me which platform path from §8 applies (native material and glass, or
   CSS-only) and confirm the ground: transparent-over-material, or solid #1b212a.
3. Ask for Headroom's brand colour. It replaces --brand and is used only for
   identity and emphasis, never for controls; --blue stays the control accent.

Then apply the theme in this order, checking each in both light and dark if
Headroom supports both (Mark defaults to dark):
1. Tokens (§2), as CSS variables or their equivalent, dark first.
2. Type (§3).
3. Surfaces (§4): ground, panes for every floating group of controls, one floor,
   opaque content. Panes are capsules when they are bars; concentric radii
   otherwise (§6).
4. Controls (§5), including the segmented control with the sliding lens -- port
   placeLens as given, including its snap-on-first-render rule.
5. Motion (§7), with prefers-reduced-motion respected.
6. Anything Headroom has that Mark does not (tables, charts, long lists): derive
   it from the same ladder and temperature. Categorical chart colours must read
   against #1b212a and be tested against --ink and the ground.

Verify, and show me:
- Screenshots of every major screen in dark (and light if applicable).
- Contrast: --ink and --muted against every surface they appear on; report any
  pair under 4.5:1 for body text or 3:1 for large text and fix it by moving the
  text onto a pane, not by frosting the ground.
- That no toolbar, tab strip or button row can silently clip: measure the
  widest real state at each width you support, and hide controls by explicit
  breakpoint in order of what has a keyboard fallback (rule 2).
- That the lens is under the active segment on the first frame with no waiting,
  and after a group is hidden and shown again.

Do not use these rules to restyle components that are not part of the shell
(third-party embeds, charts' own internals) without asking. When a rule in the
document conflicts with something Headroom already does deliberately, say so and
ask rather than silently picking one.
```
