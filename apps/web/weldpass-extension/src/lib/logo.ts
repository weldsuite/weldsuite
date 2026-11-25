/**
 * The WeldPass logo: Lucide's asterisk at a 2.5 stroke, cropped to its own
 * bounds, as in apps/web/platform/public/assets/images/weldpass/icon.svg (the
 * toolbar icons are rasterized from that file by scripts/generate-icons.mjs).
 * The popup, the inline menu, the save bar and the icon in a login field draw
 * it in `currentColor`.
 */
export const LOGO_VIEW_BOX = '4.435 4.435 15.13 15.13';
export const LOGO_PATH = 'M12 6v12M17.196 9 6.804 15M6.804 9l10.392 6';
export const LOGO_STROKE_WIDTH = 2.5;

/** The logo as markup, for the content script, which has no React. */
export function logoSvg(size: number): string {
  return (
    `<svg viewBox="${LOGO_VIEW_BOX}" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="${LOGO_STROKE_WIDTH}" stroke-linecap="round" aria-hidden="true"><path d="${LOGO_PATH}"/></svg>`
  );
}
