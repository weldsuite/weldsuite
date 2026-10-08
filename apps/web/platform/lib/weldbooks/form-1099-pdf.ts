/**
 * 1099 recipient and payer copies as a PDF, drawn with pdf-lib from the layout
 * data `GET /api/form-1099/filings/:id/lines/:lineId/copies` returns
 * (`form1099PdfCopies` in `@weldsuite/books-domain`).
 *
 * Every copy is one US Letter page; the server gives each box a position and a
 * size in points with the origin at the top-left, a printed caption, and the
 * value to print. These are substitute statements for the recipient (Copy B,
 * Copy 2), the state (Copy 1) and the payer (Copy C), not the scannable red
 * Copy A: the IRS takes the data through IRIS instead. The recipient's TIN is
 * only the last four digits, because that is all the server sends.
 *
 * The standard PDF fonts cannot draw every Unicode character, so a character
 * they can't encode prints as "?" instead of failing the whole document.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Form1099Copy, Form1099PdfCopy, Form1099PdfField, Form1099PdfTextBlock } from '@/lib/api/domains/weldbooks-1099';

const INK = rgb(0.05, 0.05, 0.08);
const CAPTION = rgb(0.3, 0.32, 0.38);
const RULE = rgb(0.45, 0.47, 0.52);
const FOOTER = rgb(0.45, 0.47, 0.52);

/** Space between a box outline and its text. */
const PAD = 3;
/** Smallest size a value shrinks to before it is cut off. */
const MIN_VALUE_SIZE = 6;
/** Where text blocks that run past the page continue, and where they stop. */
const PAGE_MARGIN = 40;
const FOOTER_RESERVE = 34;

export interface Form1099PdfFonts {
  regular: PDFFont;
  bold: PDFFont;
}

/** A character the font can draw, else "?". Control characters and line breaks become spaces. */
export function printable(font: PDFFont, text: string): string {
  let out = '';
  for (const char of text.replace(/[\r\n\t]+/g, ' ')) {
    try {
      font.encodeText(char);
      out += char;
    } catch {
      out += '?';
    }
  }
  return out;
}

/** Splits text on its line breaks, then wraps each part to `maxWidth` at `size`. Words longer than a line are cut. */
export function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const part of text.split('\n')) {
    const words = printable(font, part).split(' ').filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > maxWidth && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) cut -= 1;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

function clip(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let cut = text.length;
  while (cut > 0 && font.widthOfTextAtSize(`${text.slice(0, cut)}...`, size) > maxWidth) cut -= 1;
  return `${text.slice(0, cut)}...`;
}

/** PDF y of a point measured from the top of the page. */
function flip(page: PDFPage, y: number): number {
  return page.getHeight() - y;
}

function drawCaption(page: PDFPage, fonts: Form1099PdfFonts, field: Form1099PdfField, size: number): number {
  const maxWidth = field.width - PAD * 2;
  const lineHeight = size * 1.2;
  const allowed = Math.max(1, Math.floor((field.height - 16) / lineHeight));
  let lines = wrapText(fonts.regular, field.label, size, maxWidth);
  if (lines.length > allowed) {
    lines = lines.slice(0, allowed);
    lines[allowed - 1] = clip(fonts.regular, `${lines[allowed - 1]} ...`, size, maxWidth);
  }
  lines.forEach((line, index) => {
    page.drawText(line, {
      x: field.x + PAD,
      y: flip(page, field.y + PAD + size + index * lineHeight),
      size,
      font: fonts.regular,
      color: CAPTION,
    });
  });
  return field.y + PAD + lines.length * lineHeight;
}

function drawCheckbox(page: PDFPage, field: Form1099PdfField) {
  const side = 8;
  const x = field.x + PAD;
  const top = field.y + field.height - PAD - side;
  page.drawRectangle({ x, y: flip(page, top + side), width: side, height: side, borderColor: INK, borderWidth: 0.7 });
  if (field.checked) {
    const line = { thickness: 1, color: INK };
    page.drawLine({ start: { x: x + 1.5, y: flip(page, top + 1.5) }, end: { x: x + side - 1.5, y: flip(page, top + side - 1.5) }, ...line });
    page.drawLine({ start: { x: x + 1.5, y: flip(page, top + side - 1.5) }, end: { x: x + side - 1.5, y: flip(page, top + 1.5) }, ...line });
  }
}

function drawValue(
  page: PDFPage,
  fonts: Form1099PdfFonts,
  field: Form1099PdfField,
  size: number,
  captionBottom: number,
) {
  const maxWidth = field.width - PAD * 2;
  if (field.multiline) {
    const available = field.y + field.height - PAD - captionBottom;
    let fontSize = size;
    let lines = wrapText(fonts.regular, field.value, fontSize, maxWidth);
    while (lines.length * fontSize * 1.2 > available && fontSize > MIN_VALUE_SIZE) {
      fontSize -= 0.5;
      lines = wrapText(fonts.regular, field.value, fontSize, maxWidth);
    }
    const lineHeight = fontSize * 1.2;
    const fit = Math.max(1, Math.floor(available / lineHeight));
    lines.slice(0, fit).forEach((line, index) => {
      page.drawText(line, {
        x: field.x + PAD,
        y: flip(page, captionBottom + fontSize + index * lineHeight),
        size: fontSize,
        font: fonts.regular,
        color: INK,
      });
    });
    return;
  }

  const text = printable(fonts.regular, field.value);
  if (!text) return;
  let fontSize = size;
  while (fonts.regular.widthOfTextAtSize(text, fontSize) > maxWidth && fontSize > MIN_VALUE_SIZE) fontSize -= 0.5;
  const shown = clip(fonts.regular, text, fontSize, maxWidth);
  const width = fonts.regular.widthOfTextAtSize(shown, fontSize);
  page.drawText(shown, {
    x: field.align === 'right' ? field.x + field.width - PAD - width : field.x + PAD,
    y: flip(page, field.y + field.height - PAD - 1),
    size: fontSize,
    font: fonts.regular,
    color: INK,
  });
}

function drawField(page: PDFPage, fonts: Form1099PdfFonts, field: Form1099PdfField, copy: Form1099PdfCopy) {
  page.drawRectangle({
    x: field.x,
    y: flip(page, field.y + field.height),
    width: field.width,
    height: field.height,
    borderColor: RULE,
    borderWidth: 0.6,
  });
  const captionBottom = drawCaption(page, fonts, field, copy.labelFontSize);
  if (field.kind === 'checkbox') {
    drawCheckbox(page, field);
    return;
  }
  drawValue(page, fonts, field, copy.valueFontSize, captionBottom);
}

/** Draws a block of paragraphs, carrying on at the top of a new page when it reaches the bottom margin. Returns the page it ended on. */
function drawBlock(
  doc: PDFDocument,
  page: PDFPage,
  fonts: Form1099PdfFonts,
  block: Form1099PdfTextBlock,
  footer: (page: PDFPage) => void,
): PDFPage {
  const font = block.bold ? fonts.bold : fonts.regular;
  let current = page;
  let y = block.y;
  const limit = (p: PDFPage) => p.getHeight() - FOOTER_RESERVE;
  block.paragraphs.forEach((paragraph, index) => {
    // A heading paragraph in the instructions ("Instructions for Recipient") stands out.
    const heading = index === 0 && block.paragraphs.length > 3;
    const paragraphFont = heading ? fonts.bold : font;
    for (const line of wrapText(paragraphFont, paragraph, block.fontSize, block.width)) {
      if (y + block.lineHeight > limit(current)) {
        footer(current);
        current = doc.addPage([current.getWidth(), current.getHeight()]);
        y = PAGE_MARGIN;
      }
      y += block.lineHeight;
      if (line) {
        current.drawText(line, { x: block.x, y: flip(current, y - 2), size: block.fontSize, font: paragraphFont, color: INK });
      }
    }
    y += block.paragraphGap ?? 0;
  });
  return current;
}

function drawCopy(doc: PDFDocument, fonts: Form1099PdfFonts, copy: Form1099PdfCopy) {
  const page = doc.addPage([copy.page.width, copy.page.height]);
  const footer = (target: PDFPage) => {
    const size = 7;
    const text = printable(fonts.regular, copy.footer);
    const width = fonts.regular.widthOfTextAtSize(text, size);
    target.drawText(text, {
      x: (target.getWidth() - width) / 2,
      y: 22,
      size,
      font: fonts.regular,
      color: FOOTER,
    });
  };

  page.drawText(printable(fonts.bold, copy.title), { x: 36, y: flip(page, 44), size: 13, font: fonts.bold, color: INK });
  page.drawText(printable(fonts.regular, copy.copyLabel), { x: 36, y: flip(page, 62), size: 9, font: fonts.regular, color: CAPTION });

  for (const field of copy.fields) drawField(page, fonts, field, copy);

  let last = page;
  for (const block of copy.blocks) last = drawBlock(doc, last, fonts, block, footer);
  // The footer goes on every page of the copy, the one the text ended on last.
  footer(last);
  if (last !== page) footer(page);
}

/**
 * One PDF with a page per copy, in the order given. Pass the copies of one
 * recipient for a single download, or the copies of every recipient for the
 * batch. A copy whose text runs past the page continues on a following page.
 */
export async function renderForm1099Pdf(copies: readonly Form1099PdfCopy[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(copies[0]?.title ?? 'Form 1099');
  doc.setProducer('WeldBooks');
  const fonts: Form1099PdfFonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  for (const copy of copies) drawCopy(doc, fonts, copy);
  return doc.save();
}

/** The same file name for a copy set: `1099-NEC-2026-acme-llc-copy-B.pdf`. */
export function form1099PdfFilename(parts: {
  form: 'nec' | 'misc';
  taxYear: number;
  recipient?: string;
  copies?: readonly Form1099Copy[];
}): string {
  const slug = (parts.recipient ?? '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .slice(0, 40);
  const copies = parts.copies && parts.copies.length > 0 ? `copy-${parts.copies.join('-')}` : '';
  return ['1099', parts.form.toUpperCase(), String(parts.taxYear), slug, copies].filter(Boolean).join('-') + '.pdf';
}
