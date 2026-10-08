/** Geometry for the selection overlay, in display points. */
export interface Rect { x: number; y: number; width: number; height: number }

/** A selection belongs to one display, so it never leaves that display's bounds.
 *  Size is clamped first: a rectangle wider than the screen is pinned to it
 *  rather than pushed off the left edge. */
export function clampRect(rect: Rect, width: number, height: number): Rect {
  const w = Math.min(Math.max(rect.width, 0), width);
  const h = Math.min(Math.max(rect.height, 0), height);
  return {
    x: Math.min(Math.max(rect.x, 0), width - w),
    y: Math.min(Math.max(rect.y, 0), height - h),
    width: w, height: h,
  };
}

/** Snap a dragged size onto a locked ratio (width ÷ height), growing the shorter
 *  side rather than shrinking what the pointer already covered. */
export function fitRatio(width: number, height: number, ratio: number): { width: number; height: number } {
  if (!Number.isFinite(ratio) || ratio <= 0) return { width, height };
  return width / Math.max(height, 1) > ratio
    ? { width, height: width / ratio }
    : { width: height * ratio, height };
}

/** A crop held to a ratio (width ÷ height), from a fixed corner toward the
 *  pointer: as large as the pointer asks at that ratio, following whichever
 *  side it pulls further, then shrunk -- never squashed -- to stay on the image.
 *  Clamping the sides separately, as clampRect does, would bend the ratio at
 *  the image's edge. */
export function ratioRect(ax: number, ay: number, px: number, py: number,
                          ratio: number, width: number, height: number): Rect {
  const right = px >= ax, down = py >= ay;
  let w = Math.abs(px - ax), h = Math.abs(py - ay);
  if (w >= h * ratio) h = w / ratio; else w = h * ratio;
  const roomX = right ? width - ax : ax, roomY = down ? height - ay : ay;
  const shrink = Math.min(1, w > 0 ? roomX / w : 1, h > 0 ? roomY / h : 1);
  w *= shrink; h *= shrink;
  return { x: right ? ax : ax - w, y: down ? ay : ay - h, width: w, height: h };
}

/** The largest rectangle of a ratio inside another, centred in it: what a crop
 *  becomes when a shape is chosen for it. */
export function ratioInside(rect: Rect, ratio: number): Rect {
  const width = Math.min(rect.width, rect.height * ratio), height = width / ratio;
  return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height };
}
