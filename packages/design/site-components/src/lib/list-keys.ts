/**
 * Stable React keys for lists that have no ids of their own.
 */

/** The lines of a multi-line string, each with the offset it starts at in the text. */
export function textLines(text: string): { offset: number; line: string; last: boolean }[] {
  const lines = text.split('\n');
  let offset = 0;
  return lines.map((line, index) => {
    const entry = { offset, line, last: index === lines.length - 1 };
    offset += line.length + 1;
    return entry;
  });
}

/** Star positions 1..count for a rating row. */
export function starSlots(count: number): number[] {
  return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, i) => i + 1);
}
