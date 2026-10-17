/** Colour arithmetic for #rrggbb colours: tints, shades and WCAG contrast. Used by the layout engine and the presets. */

function channels(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  return [Number.parseInt(m[1], 16), Number.parseInt(m[2], 16), Number.parseInt(m[3], 16)];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;
}

/** `hex` mixed with `other` by `amount` (0 = hex, 1 = other). */
export function mix(hex: string, other: string, amount: number): string {
  const a = channels(hex);
  const b = channels(other);
  return toHex([0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * amount) as [number, number, number]);
}

/** A light tint of a colour: `amount` of the way to white (0.9 = a very pale wash). */
export function tint(hex: string, amount: number): string {
  return mix(hex, '#ffffff', amount);
}

/** A darker shade of a colour: `amount` of the way to black. */
export function shade(hex: string, amount: number): string {
  return mix(hex, '#000000', amount);
}

/** WCAG relative luminance of a colour, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** White or near-black, whichever reads better on `background` (a light accent such as yellow gets dark text). */
export function readableOn(background: string, dark = '#1a1a1f'): string {
  const l = luminance(background);
  const contrastWhite = 1.05 / (l + 0.05);
  const contrastDark = (l + 0.05) / (luminance(dark) + 0.05);
  return contrastWhite >= contrastDark ? '#ffffff' : dark;
}

/** WCAG contrast ratio between two colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The accent made dark enough to read as text on `background` (white by default): returned as is
 * when it already reaches `ratio`, otherwise shaded step by step. Keeps a pale accent (yellow, mint)
 * usable for titles and amounts.
 */
export function legible(accent: string, background = '#ffffff', ratio = 4.5): string {
  let colour = accent;
  for (let step = 0; step < 20 && contrast(colour, background) < ratio; step++) colour = shade(colour, 0.12);
  return colour;
}
