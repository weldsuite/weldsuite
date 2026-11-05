/** Zoom steps of the board viewer: 100% is the board fitted to the screen's width. */
export const BOARD_ZOOMS = [1, 1.5, 2, 3, 4] as const;

/** The next zoom step up (dir 1) or down (dir -1) from `zoom`, staying within the steps. */
export function nextZoom(zoom: number, dir: 1 | -1): number {
  const steps = BOARD_ZOOMS as readonly number[];
  if (dir === 1) return steps.find((s) => s > zoom + 0.001) ?? steps[steps.length - 1]!;
  return [...steps].reverse().find((s) => s < zoom - 0.001) ?? steps[0]!;
}

/** The width and height an SVG says it has (its root's attributes), or null. */
export function boardSvgSize(svg: string): { width: number; height: number } | null {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!root) return null;
  const width = Number(/\swidth="([\d.]+)"/.exec(root)?.[1]);
  const height = Number(/\sheight="([\d.]+)"/.exec(root)?.[1]);
  return width > 0 && height > 0 ? { width, height } : null;
}
