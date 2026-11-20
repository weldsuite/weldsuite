/**
 * The colours a chart gives its categories in turn when they bring none: the
 * theme's two chart blues, then teal, purple, orange, green, red and amber,
 * the colours the WeldBooks dashboard uses.
 */
export const CHART_PALETTE = ['var(--chart-1)', 'var(--chart-2)', '#00a2b8', '#8d7ffa', '#ed6704', '#10b981', '#df1b41', '#f5b900'];

export const paletteColor = (index: number) => CHART_PALETTE[index % CHART_PALETTE.length];

/** A colour at a strength, for tints: `tint('var(--chart-1)', 18)`. */
export const tint = (color: string, percent: number) => `color-mix(in oklab, ${color} ${percent}%, transparent)`;

/** Where the pointer is inside an element, for placing a hover card next to it. */
export function pointerIn(element: HTMLElement | null, event: { clientX: number; clientY: number }) {
  const box = element?.getBoundingClientRect();
  return box ? { x: event.clientX - box.left, y: event.clientY - box.top, width: box.width, height: box.height } : null;
}

/** A hover card's left and top beside the pointer, flipped to its other side near the right edge. */
export function cardBeside(pointer: { x: number; y: number; width: number }, cardWidth = 180) {
  const left = pointer.x + 14 + cardWidth > pointer.width ? Math.max(pointer.x - 14 - cardWidth, 0) : pointer.x + 14;
  return { left, top: pointer.y + 14 };
}
