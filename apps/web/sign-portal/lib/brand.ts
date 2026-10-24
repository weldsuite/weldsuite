/** Workspace branding helpers. Brand data comes from the sender, so validate before using it in CSS or markup. */

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A `#rgb` / `#rrggbb` colour, or null for anything else. */
export function safeBrandColor(color: string | null | undefined): string | null {
  const value = color?.trim();
  return value && HEX.test(value) ? value : null;
}

/** Only http(s) logos are rendered. */
export function safeLogoUrl(url: string | null | undefined): string | null {
  const value = url?.trim();
  return value && /^https?:\/\//i.test(value) ? value : null;
}

/** Text colour that stays readable on the brand colour (WCAG relative luminance). */
export function readableOn(hex: string): '#ffffff' | '#111111' {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const channel = (i: number): number => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.4 ? '#111111' : '#ffffff';
}
