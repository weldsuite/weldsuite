/**
 * SVG painter: one `<svg>` per page, in points, drawing exactly what the
 * layout engine placed. The designer's live preview and the printable HTML of
 * books-api both use it, so they match the PDF.
 */
import type { FontFace } from './fonts';
import type { InvoiceLayout, Primitive } from './layout';
import { safeImageSrc } from './layout';
import type { TemplateFont } from './schema';

const FONT_STACKS: Record<TemplateFont, string> = {
  helvetica: "Helvetica, Arial, 'Liberation Sans', sans-serif",
  times: "'Times New Roman', Times, 'Liberation Serif', serif",
  courier: "'Courier New', Courier, 'Liberation Mono', monospace",
};

export function fontStack(font: TemplateFont): string {
  return FONT_STACKS[font] ?? FONT_STACKS.helvetica;
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
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(width)} ${n(height)}"${size}${cls} xml:space="preserve" style="white-space:pre"><rect width="100%" height="100%" fill="#ffffff"/>${body}</svg>`;
}

/**
 * A printable HTML document: every page an SVG, one per printed sheet. With
 * `mobile` (the `./mobile` layout), phones get that single column instead of
 * a shrunken page; printing always uses the pages.
 */
export function renderInvoiceHtmlDocument(layout: InvoiceLayout, opts: { title: string; lang?: string; mobile?: string }): string {
  const pages = layout.pages.map((_, i) => `<div class="page">${renderPageSvg(layout, i)}</div>`).join('\n');
  const mobile = opts.mobile ? `\n<div class="mobile">${opts.mobile}</div>` : '';
  return `<!DOCTYPE html>
<html lang="${esc((opts.lang ?? 'en').split('-')[0])}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(opts.title)}</title>
<style>
  @page { size: ${n(layout.width)}pt ${n(layout.height)}pt; margin: 0; }
  html, body { margin: 0; padding: 0; background: #e9ebef; }
  .page { width: ${n(layout.width)}pt; max-width: 100%; margin: 16px auto; box-shadow: 0 1px 4px rgba(0,0,0,.15); background: #fff; }
  .page svg { display: block; width: 100%; height: auto; }
  .mobile { display: none; }
  @media screen and (max-width: 640px) {
    html, body { background: #fff; }
    body.has-mobile .page { display: none; }
    body.has-mobile .mobile { display: block; }
  }
  @media print {
    html, body { background: #fff; }
    .mobile { display: none !important; }
    .page { display: block !important; }
    .page { margin: 0; box-shadow: none; max-width: none; break-after: page; }
    .page:last-child { break-after: auto; }
  }
</style>
</head>
<body${opts.mobile ? ' class="has-mobile"' : ''}>
${pages}${mobile}
</body>
</html>`;
}
