/**
 * Axis maths shared by the hand-drawn charts (scatter, stacked area): a linear
 * scale, crisp 1px grid lines and room for the y labels on the right, as the
 * dashboard's charts draw them.
 */

/**
 * A 1px rule's y, moved to the middle of a pixel row, so every grid line is
 * one sharp row instead of two dim ones.
 */
export const onPixelRow = (y: number) => Math.round(y - 0.5) + 0.5;

/** Maps `domain` onto `range` linearly; a domain of one value maps to the range's start. */
export function linearScale([d0, d1]: readonly [number, number], [r0, r1]: readonly [number, number]) {
  const span = d1 - d0;
  return (value: number) => (span === 0 ? r0 : r0 + ((value - d0) / span) * (r1 - r0));
}

/** The width the y labels on the right need: about 7px a character, plus the gap to the plot. */
export const labelGutter = (labels: readonly string[]) => Math.ceil(Math.max(0, ...labels.map((label) => label.length)) * 7) + 12;
