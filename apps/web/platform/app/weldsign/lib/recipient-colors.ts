/**
 * One colour per recipient, so the fields of each signer are easy to tell
 * apart in the editor. Chosen to stay readable on a white page in both themes.
 */

const PALETTE = [
  { border: '#4f46e5', fill: 'rgba(79, 70, 229, 0.14)', chip: 'bg-indigo-600' },
  { border: '#d97706', fill: 'rgba(217, 119, 6, 0.14)', chip: 'bg-amber-600' },
  { border: '#059669', fill: 'rgba(5, 150, 105, 0.14)', chip: 'bg-emerald-600' },
  { border: '#db2777', fill: 'rgba(219, 39, 119, 0.14)', chip: 'bg-pink-600' },
  { border: '#0284c7', fill: 'rgba(2, 132, 199, 0.14)', chip: 'bg-sky-600' },
  { border: '#7c3aed', fill: 'rgba(124, 58, 237, 0.14)', chip: 'bg-violet-600' },
  { border: '#dc2626', fill: 'rgba(220, 38, 38, 0.14)', chip: 'bg-red-600' },
  { border: '#65a30d', fill: 'rgba(101, 163, 13, 0.14)', chip: 'bg-lime-600' },
] as const;

export type RecipientColor = (typeof PALETTE)[number];

/** Colour of the recipient at `index` in the envelope's recipient list. */
export function recipientColor(index: number): RecipientColor {
  return PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length]!;
}
