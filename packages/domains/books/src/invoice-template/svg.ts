/**
 * SVG painter: one `<svg>` per page, in points, drawing exactly what the
 * layout engine placed. The designer's live preview and the printable HTML of
 * books-api both use it, so they match the PDF.
 */
import { FONT_FACE_KEYS, FONT_METRICS, fontFamilyOf, type FontFace, type FontFaceKey, type FontFamilyKey } from './fonts';
import type { InvoiceLayout, Primitive } from './layout';
import { safeImageSrc } from './layout';
import type { TemplateFont } from './schema';

/**
 * The bundled fonts under their own family names, so a different version of
 * Noto installed on the reader's machine never stands in with other widths.
 */
const FAMILY_NAMES: Record<FontFamilyKey, string> = {
  sans: 'WeldBooks Noto Sans',
  serif: 'WeldBooks Noto Serif',
  mono: 'WeldBooks Noto Sans Mono',
};

/** Used only while the bundled font loads, or if it cannot. */
const FALLBACK_STACKS: Record<FontFamilyKey, string> = {
  sans: "'Noto Sans', Helvetica, Arial, sans-serif",
  serif: "'Noto Serif', 'Times New Roman', Times, serif",
  mono: "'Noto Sans Mono', 'Courier New', Courier, monospace",
};

export function fontStack(font: TemplateFont): string {
  const family = fontFamilyOf(font);
  return `'${FAMILY_NAMES[family]}', ${FALLBACK_STACKS[family]}`;
}

/**
 * Where the browser fetches a bundled font file. `hash` changes with the
 * file's contents, so the URL can be cached forever.
 */
export type FontUrlResolver = (file: string, hash: string) => string;

/**
 * @font-face rules for the bundled fonts. The SVG pages name these families;
 * a browser downloads only the faces a page actually uses.
 */
export function invoiceFontFaceCss(fontUrl: FontUrlResolver): string {
  return FONT_FACE_KEYS.map((key: FontFaceKey) => {
    const { file, hash } = FONT_METRICS[key];
    const [family, ...style] = key.split('-') as [FontFamilyKey, ...string[]];
    const bold = style.includes('bold');
    const italic = style.includes('italic');
    // A <style> element is raw text: keep the URL from closing the string or the element.
    const url = fontUrl(file, hash).replace(/["'\\<>\s]/g, encodeURIComponent);
    return `@font-face{font-family:'${FAMILY_NAMES[family]}';src:url("${url}") format("truetype");font-weight:${bold ? 700 : 400};font-style:${italic ? 'italic' : 'normal'};font-display:block}`;
  }).join('\n');
}

function esc(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** Colours reach attributes; anything but a hex colour becomes black. */
function col(value: string | undefined): string {
  return value && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : '#000000';
}

const n = (v: number) => Number(v.toFixed(2));

const IMAGE_ALIGN = { left: 'xMin', center: 'xMid', right: 'xMax' } as const;

function fontAttrs(face: FontFace): string {
  return `font-family="${esc(fontStack(face.font))}"${face.bold ? ' font-weight="bold"' : ''}${face.italic ? ' font-style="italic"' : ''}`;
}

function primitiveSvg(p: Primitive, width: number, height: number): string {
  switch (p.kind) {
    case 'text':
      return `<text x="${n(p.x)}" y="${n(p.y)}" font-size="${n(p.size)}" ${fontAttrs(p.face)} fill="${col(p.color)}">${esc(p.text)}</text>`;
    case 'rect': {
      const fill = p.fill ? col(p.fill) : 'none';
      const stroke = p.stroke ? ` stroke="${col(p.stroke)}" stroke-width="${n(p.strokeWidth ?? 1)}"` : '';
      const radius = p.radius ? ` rx="${n(p.radius)}"` : '';
      return `<rect x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}" fill="${fill}"${stroke}${radius}/>`;
    }
    case 'line':
      return `<line x1="${n(p.x1)}" y1="${n(p.y1)}" x2="${n(p.x2)}" y2="${n(p.y2)}" stroke="${col(p.color)}" stroke-width="${n(p.width)}"/>`;
    case 'image': {
      const src = safeImageSrc(p.src);
      if (!src) return '';
      return `<image href="${esc(src)}" x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}" preserveAspectRatio="${IMAGE_ALIGN[p.align]}YMid meet"/>`;
    }
    case 'qr': {
      const cell = p.size / Math.max(1, p.matrix.length);
      let d = '';
      p.matrix.forEach((row, r) =>
        row.forEach((dark, c) => {
          if (dark) d += `M${n(p.x + c * cell)} ${n(p.y + r * cell)}h${n(cell)}v${n(cell)}h${n(-cell)}z`;
        }),
      );
      return `<rect x="${n(p.x)}" y="${n(p.y)}" width="${n(p.size)}" height="${n(p.size)}" fill="#ffffff"/><path d="${d}" fill="#000000" shape-rendering="crispEdges"/>`;
    }
    case 'watermark':
      return `<text x="${n(width / 2)}" y="${n(height / 2)}" font-size="${n(p.size)}" ${fontAttrs(p.face)} fill="${col(p.color)}" fill-opacity="0.08" text-anchor="middle" dominant-baseline="middle" transform="rotate(-30 ${n(width / 2)} ${n(height / 2)})">${esc(p.text)}</text>`;
  }
}

/** The SVG markup of one page; `className` lets the caller size it. */
export function renderPageSvg(layout: InvoiceLayout, pageIndex: number, opts: { className?: string; withSize?: boolean } = {}): string {
  const page = layout.pages[pageIndex];
  if (!page) return '';
  const { width, height } = layout;
  const size = opts.withSize === false ? '' : ` width="${n(width)}pt" height="${n(height)}pt"`;
  const cls = opts.className ? ` class="${esc(opts.className)}"` : '';
  const body = page.primitives.map((p) => primitiveSvg(p, width, height)).join('');
  // No kerning or ligatures: the layout measured each character at its advance width.
  const style = 'white-space:pre;font-kerning:none;font-variant-ligatures:none;font-feature-settings:"kern" 0,"liga" 0;text-rendering:geometricPrecision';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(width)} ${n(height)}"${size}${cls} xml:space="preserve" style='${style}'><rect width="100%" height="100%" fill="#ffffff"/>${body}</svg>`;
}

/**
 * A printable HTML document: every page an SVG, one per printed sheet.
 * `fontUrl` points the @font-face rules at the bundled fonts; without it the
 * pages fall back to the system fonts of the same style.
 */
export function renderInvoiceHtmlDocument(layout: InvoiceLayout, opts: { title: string; lang?: string; fontUrl?: FontUrlResolver }): string {
  const pages = layout.pages.map((_, i) => `<div class="page">${renderPageSvg(layout, i)}</div>`).join('\n');
  return `<!DOCTYPE html>
<html lang="${esc((opts.lang ?? 'en').split('-')[0])}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(opts.title)}</title>
<style>
${opts.fontUrl ? `${invoiceFontFaceCss(opts.fontUrl)}\n` : ''}  @page { size: ${n(layout.width)}pt ${n(layout.height)}pt; margin: 0; }
  html, body { margin: 0; padding: 0; background: #e9ebef; }
  .page { width: ${n(layout.width)}pt; max-width: 100%; margin: 16px auto; box-shadow: 0 1px 4px rgba(0,0,0,.15); background: #fff; }
  .page svg { display: block; width: 100%; height: auto; }
  @media print {
    html, body { background: #fff; }
    .page { margin: 0; box-shadow: none; max-width: none; break-after: page; }
    .page:last-child { break-after: auto; }
  }
</style>
</head>
<body>
${pages}
</body>
</html>`;
}
