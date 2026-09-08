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
