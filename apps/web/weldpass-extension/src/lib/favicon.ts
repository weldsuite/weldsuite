/**
 * A login's site icon, from the browser's own favicon cache (the `favicon`
 * permission, ADR PASS-009). The URL points into the extension
 * (`chrome-extension://<id>/_favicon/`), so showing it makes no network
 * request and tells no server which sites are in the vault. A site the
 * browser has no icon for comes back as the browser's default globe.
 *
 * Only extension pages may use it: a content script would need `_favicon/*`
 * among the web accessible resources, which PASS-009 doesn't allow.
 */
export function faviconUrl(pageUrl: string | null | undefined, size = 32): string | null {
  if (!pageUrl || typeof chrome === 'undefined' || !chrome.runtime?.getURL) return null;

  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  if (page.protocol !== 'https:' && page.protocol !== 'http:') return null;

  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', page.href);
  url.searchParams.set('size', String(size));
  return url.href;
}

/** The size an icon is sampled at. */
const SAMPLE_SIZE = 32;
/** How far in from each corner a square's corner is sampled: a rounded square still counts. */
const CORNER_INSET = 4;
/** How far in from each edge a round icon's edge is sampled. */
const EDGE_INSET = 2;

export type IconShape = 'square' | 'round' | 'glyph';

/** One pixel, 0-255 per channel. */
export type Pixel = readonly [red: number, green: number, blue: number, alpha: number];

const opaque = ([, , , alpha]: Pixel) => alpha > 200;
const nearWhite = ([red, green, blue]: Pixel) => red > 235 && green > 235 && blue > 235;

/**
 * How an icon should sit in its 32px tile, from the icon drawn at 32x32:
 *
 * - `square`: an app-icon style favicon whose background reaches its corners
 *   (LinkedIn, Cloudflare, Stripe). It fills the tile.
 * - `round`: a full circle in a colour of its own (Vercel). It fills the tile
 *   as a circle.
 * - `glyph`: a mark on a transparent or white background (Figma, GitHub,
 *   Google's G on a white circle). It sits centred in a bordered tile; a white
 *   circle filling the tile would only lose its edge against the popup.
 */
export function iconShape(pixelAt: (x: number, y: number) => Pixel): IconShape {
  const far = SAMPLE_SIZE - 1;
  const corners = [
    pixelAt(CORNER_INSET, CORNER_INSET),
    pixelAt(far - CORNER_INSET, CORNER_INSET),
    pixelAt(CORNER_INSET, far - CORNER_INSET),
    pixelAt(far - CORNER_INSET, far - CORNER_INSET),
  ];
  if (corners.every(opaque)) return 'square';

  const middle = Math.floor(SAMPLE_SIZE / 2);
  const edges = [
    pixelAt(middle, EDGE_INSET),
    pixelAt(EDGE_INSET, middle),
    pixelAt(far - EDGE_INSET, middle),
    pixelAt(middle, far - EDGE_INSET),
  ];
  let filled = 0;
  for (let y = 0; y < SAMPLE_SIZE; y += 1) {
    for (let x = 0; x < SAMPLE_SIZE; x += 1) if (pixelAt(x, y)[3] > 128) filled += 1;
  }
  const disc = filled / (SAMPLE_SIZE * SAMPLE_SIZE) >= 0.75;
  return disc && edges.every((pixel) => opaque(pixel) && !nearWhite(pixel)) ? 'round' : 'glyph';
}

/**
 * `iconShape` for a loaded image. An icon the page may not read (from another
 * origin without CORS) counts as a glyph, which keeps it in its tile. The
 * favicon cache is the extension's own origin, so its icons can be read.
 */
export function imageShape(image: HTMLImageElement): IconShape {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return 'glyph';
    context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const data = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
    return iconShape((x, y) => {
      const i = (y * SAMPLE_SIZE + x) * 4;
      return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, data[i + 3] ?? 0];
    });
  } catch {
    return 'glyph';
  }
}
