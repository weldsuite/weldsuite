/** Byte order, as Rust compares strings (locale-independent). */
export function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
