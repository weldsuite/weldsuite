/**
 * Canvas helpers for adopted signatures: render typed text, load an uploaded
 * image, and export any canvas as a trimmed transparent PNG that fits the
 * contract (`portalSignatureSchema`: a PNG data URL under 700,000 characters).
 */

/** Largest exported image, in pixels. */
export const SIGNATURE_MAX_WIDTH = 600;
export const SIGNATURE_MAX_HEIGHT = 200;
/** Backing size of the drawing pad (3:1, drawn at 1.5x the export size for smooth strokes). */
export const PAD_WIDTH = 900;
export const PAD_HEIGHT = 300;

const MAX_DATA_URL_LENGTH = 690_000;
const INK = '#14213d';
const SCRIPT_FONTS = '"Segoe Script", "Snell Roundhand", "Brush Script MT", "Lucida Handwriting", "Apple Chancery", "URW Chancery L", cursive';

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function inkColor(): string {
  return INK;
}

/** Bounding box of every non-transparent pixel, or null for an empty canvas. */
function contentBounds(canvas: HTMLCanvasElement): { x: number; y: number; width: number; height: number } | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Ignore faint anti-aliasing noise so a stray pixel does not count as a signature.
      if (data[(y * width + x) * 4 + 3]! > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Trim the canvas to its ink (plus a small margin), scale it down to fit
 * 600x200 and encode it. Reports `empty` for a blank canvas and `tooLarge` when
 * the result is still over the size limit after shrinking.
 */
export function exportTrimmedPng(source: HTMLCanvasElement): { image: string } | { error: 'empty' | 'tooLarge' } {
  const bounds = contentBounds(source);
  if (!bounds) return { error: 'empty' };
  const margin = Math.round(Math.max(bounds.width, bounds.height) * 0.04) + 2;
  const cropW = bounds.width + margin * 2;
  const cropH = bounds.height + margin * 2;

  let scale = Math.min(1, SIGNATURE_MAX_WIDTH / cropW, SIGNATURE_MAX_HEIGHT / cropH);
  for (let attempt = 0; attempt < 5; attempt++) {
    const out = createCanvas(Math.max(1, Math.round(cropW * scale)), Math.max(1, Math.round(cropH * scale)));
    const ctx = out.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { error: 'tooLarge' };
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, bounds.x - margin, bounds.y - margin, cropW, cropH, 0, 0, out.width, out.height);
    const image = out.toDataURL('image/png');
    if (image.length <= MAX_DATA_URL_LENGTH) return { image };
    scale *= 0.75;
  }
  return { error: 'tooLarge' };
}

/** Render a name in a script style onto a transparent pad-sized canvas. */
export function renderTypedSignature(text: string): HTMLCanvasElement {
  const canvas = createCanvas(PAD_WIDTH, PAD_HEIGHT);
  const value = text.trim();
  if (!value) return canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return canvas;
  const fontSize = 160;
  ctx.font = `italic ${fontSize}px ${SCRIPT_FONTS}`;
  const measured = ctx.measureText(value).width;
  // Shrink long names so they fit the pad with room to spare.
  const size = measured > PAD_WIDTH * 0.92 ? Math.floor(fontSize * ((PAD_WIDTH * 0.92) / measured)) : fontSize;
  ctx.font = `italic ${size}px ${SCRIPT_FONTS}`;
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(value, PAD_WIDTH / 2, PAD_HEIGHT / 2);
  return canvas;
}

/**
 * Draw an uploaded picture onto a pad-sized canvas. Near-white pixels become
 * transparent, so a photo of a signature on white paper does not put a white
 * box over the document.
 */
export async function renderUploadedSignature(file: File): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('unreadable'));
      el.src = url;
    });
    const naturalW = img.naturalWidth || img.width;
    const naturalH = img.naturalHeight || img.height;
    if (!naturalW || !naturalH) throw new Error('unreadable');
    const fit = Math.min(PAD_WIDTH / naturalW, PAD_HEIGHT / naturalH, 1.5);
    const w = Math.max(1, Math.round(naturalW * fit));
    const h = Math.max(1, Math.round(naturalH * fit));
    const canvas = createCanvas(PAD_WIDTH, PAD_HEIGHT);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('unreadable');
    const dx = Math.round((PAD_WIDTH - w) / 2);
    const dy = Math.round((PAD_HEIGHT - h) / 2);
    ctx.drawImage(img, dx, dy, w, h);
    const region = ctx.getImageData(dx, dy, w, h);
    const px = region.data;
    for (let i = 0; i < px.length; i += 4) {
      // Soft ramp from opaque (dark) to transparent (white).
      const luminance = 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
      if (luminance > 245) px[i + 3] = 0;
      else if (luminance > 200) px[i + 3] = Math.round((px[i + 3]! * (245 - luminance)) / 45);
    }
    ctx.putImageData(region, dx, dy);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** "Anna van der Berg" becomes "AB"; at most three letters. */
export function initialsFromName(name: string | null | undefined): string {
  const words = (name ?? '')
    .trim()
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w));
  if (words.length === 0) return '';
  const letters = words.map((w) => Array.from(w).find((c) => /\p{L}/u.test(c)) ?? '');
  const picked = words.length > 2 ? [letters[0], letters[words.length - 1]] : letters;
  return picked.join('').toUpperCase().slice(0, 3);
}
