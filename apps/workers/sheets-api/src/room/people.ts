/** Small helpers for who is in a room and what new workbooks look like. */

/** Distinct, readable on white and on the dark grid; cursors and avatars use them. */
const PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#db2777', '#65a30d', '#4f46e5', '#ca8a04'];

/** The same colour for a person in every sheet, so teammates learn it. */
export function colorFor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}

/** Tab id in the editor's format (`newSheetId` in the platform). */
export function newTabId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `sh_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
