/** How a recording shows the pointer and clicks: chosen before it starts, in
 *  the overlay's bar or in Settings, and afterwards, in the editor, for as
 *  much as Mark draws. The arrow and the rings are macOS's own, recorded into
 *  the movie and there to stay; the halo, the fingertip and the ripple are
 *  drawn over it by Mark, as recording.rs decides, so they can change.
 *  Shared by all three pages, so they offer the same choices. */
import './look.css';

export type PointerLook = 'arrow' | 'halo' | 'touch' | 'hidden';
export type ClickLook = 'rings' | 'ripple' | 'none';
export interface Look { pointer: PointerLook; clicks: ClickLook }

/** As a recording starts when nothing has been chosen: as macOS shows it. */
export const PLAIN: Look = { pointer: 'arrow', clicks: 'rings' };

interface Choice<T> { id: T; name: string; hint: string; art: string }

const ARROW = '<path d="M6.4 3.6v11.6l3.1-2.9 2 4.3 1.8-.8-2-4.3 4.3-.2z" fill="currentColor"/>';
export const POINTERS: readonly Choice<PointerLook>[] = [
  { id: 'arrow', name: 'Arrow', hint: 'The Mac’s own', art: ARROW },
  { id: 'halo', name: 'Halo', hint: 'A soft glow follows it',
    art: `<circle cx="9" cy="9.4" r="7" fill="currentColor" opacity=".24"/>${ARROW}` },
  { id: 'touch', name: 'Touch', hint: 'A fingertip, for phone prototypes',
    art: '<circle cx="10" cy="10" r="6.4" fill="currentColor" opacity=".35"/><circle cx="10" cy="10" r="6.4" fill="none" stroke="currentColor" stroke-width="1.4"/>' },
  { id: 'hidden', name: 'Hidden', hint: 'No pointer at all',
    art: '<path d="M6.4 3.6v11.6l3.1-2.9 2 4.3 1.8-.8-2-4.3 4.3-.2z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" opacity=".55"/><path d="M3.5 16.5 16.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' },
];
export const CLICKS: readonly Choice<ClickLook>[] = [
  { id: 'rings', name: 'Rings', hint: 'macOS’s own',
    art: '<circle cx="10" cy="10" r="6.2" fill="none" stroke="currentColor" stroke-width="1.8"/>' },
  { id: 'ripple', name: 'Ripple', hint: 'Grows and fades where you tap',
    art: '<circle cx="10" cy="10" r="2.6" fill="currentColor"/><circle cx="10" cy="10" r="5.6" fill="none" stroke="currentColor" stroke-width="1.3" opacity=".6"/><circle cx="10" cy="10" r="8.2" fill="none" stroke="currentColor" stroke-width="1.1" opacity=".3"/>' },
  { id: 'none', name: 'None', hint: 'Clicks aren’t shown',
    art: '<circle cx="10" cy="10" r="6.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 2.4" opacity=".55"/>' },
];

/** Whether a recording opens with zooms round its clicks: chosen with the
 *  pointer and clicks before it starts, since it is about the clicks too. */
const ZOOMS: readonly Choice<'on' | 'off'>[] = [
  { id: 'on', name: 'In on clicks', hint: 'Moves in gently around each burst',
    art: '<circle cx="8.6" cy="8.6" r="5.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12.4 12.4 16.4 16.4M8.6 6.4v4.4M6.4 8.6h4.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' },
  { id: 'off', name: 'Off', hint: 'The whole picture throughout',
    art: '<circle cx="8.6" cy="8.6" r="5.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 2.4" opacity=".55"/><path d="M12.4 12.4 16.4 16.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".55"/>' },
];

const isPointer = (value: unknown): value is PointerLook => POINTERS.some(choice => choice.id === value);
const isClicks = (value: unknown): value is ClickLook => CLICKS.some(choice => choice.id === value);

/** A look as another page or Rust handed it over, held to the choices there are. */
export function lookOf(value: unknown): Look {
  const given = (value ?? {}) as Partial<Record<keyof Look, unknown>>;
  return { pointer: isPointer(given.pointer) ? given.pointer : PLAIN.pointer, clicks: isClicks(given.clicks) ? given.clicks : PLAIN.clicks };
}

/** Whether macOS records the arrow into the movie: then it is there to stay. */
export const recordsArrow = (pointer: PointerLook) => pointer === 'arrow' || pointer === 'halo';

/** Why a recording made as `made` can't now be shown as `choice`, or null if
 *  it can: the arrow and the rings are in the movie or they aren't. */
export function unavailable(made: Look, choice: PointerLook | ClickLook): string | null {
  if (isPointer(choice)) {
    const arrow = recordsArrow(made.pointer);
    if (arrow && !recordsArrow(choice)) return 'The arrow is in this one';
    if (!arrow && recordsArrow(choice)) return 'Recorded without it';
    return null;
  }
  if (made.clicks === 'rings' && choice !== 'rings') return 'Rings are in this one';
  if (made.clicks !== 'rings' && choice === 'rings') return 'Only while recording';
  return null;
}

const name = (choices: readonly Choice<string>[], id: string) => choices.find(choice => choice.id === id)?.name ?? id;
/** "Touch · Ripple", for the button that opens the menu -- and "· Zoom" after
 *  it, zooming in on clicks. */
export const lookLabel = (look: Look, zoom = false) => `${name(POINTERS, look.pointer)} · ${name(CLICKS, look.clicks)}${zoom ? ' · Zoom' : ''}`;
/** The pointer's picture, for that button. */
export const pointerArt = (pointer: PointerLook) =>
  `<svg viewBox="0 0 20 20" aria-hidden="true">${POINTERS.find(choice => choice.id === pointer)?.art ?? ARROW}</svg>`;

/** The menu's groups, each choice ticked if it is the one, and -- for a
 *  recording already made -- dimmed, with why, if it can't be had. Before
 *  recording, `zoom` adds a third: whether it zooms in on clicks. Afterwards
 *  the zooms themselves are on the strip. */
export function lookItems(look: Look, made?: Look, zoom?: boolean): string {
  const group = <T extends string>(label: string, key: 'pointer' | 'clicks' | 'zoom', choices: readonly Choice<T>[], current: T) => `
    <div class="look-group" role="group" aria-label="${label}">
      <span class="look-head" aria-hidden="true">${label}</span>
      ${choices.map(choice => {
        const why = made && key !== 'zoom' ? unavailable(made, choice.id as PointerLook | ClickLook) : null;
        return `<button type="button" class="look-item" role="menuitemradio" data-${key}="${choice.id}"
          aria-checked="${choice.id === current}"${why ? ' aria-disabled="true"' : ''}>
          <svg viewBox="0 0 20 20" aria-hidden="true">${choice.art}</svg>
          <span class="look-name">${choice.name}</span><span class="look-hint">${why ?? choice.hint}</span></button>`;
      }).join('')}
    </div>`;
  return group('Pointer', 'pointer', POINTERS, look.pointer) + group('Clicks', 'clicks', CLICKS, look.clicks)
    + (zoom === undefined ? '' : group('Zoom', 'zoom', ZOOMS, zoom ? 'on' : 'off'));
}

/** What a click on the menu chose: half a look, or zooming on or off, or
 *  nothing -- a dimmed choice is nothing, as is a click between them. */
export function chosen(target: EventTarget | null): (Partial<Look> & { zoom?: boolean }) | null {
  const item = (target as Element | null)?.closest?.<HTMLElement>('.look-item');
  if (!item || item.getAttribute('aria-disabled') === 'true') return null;
  if (isPointer(item.dataset.pointer)) return { pointer: item.dataset.pointer };
  if (isClicks(item.dataset.clicks)) return { clicks: item.dataset.clicks };
  if (item.dataset.zoom === 'on' || item.dataset.zoom === 'off') return { zoom: item.dataset.zoom === 'on' };
  return null;
}
