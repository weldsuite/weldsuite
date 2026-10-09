import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFPage, StandardFonts } from 'pdf-lib';
import type { Form1099PdfCopy, Form1099PdfField } from '@/lib/api/domains/weldbooks-1099';
import { form1099PdfFilename, printable, renderForm1099Pdf, wrapText } from './form-1099-pdf';

function field(partial: Partial<Form1099PdfField> & Pick<Form1099PdfField, 'id'>): Form1099PdfField {
  return { label: partial.id, value: '', kind: 'text', x: 36, y: 90, width: 300, height: 36, align: 'left', ...partial };
}

function copy(overrides: Partial<Form1099PdfCopy> = {}): Form1099PdfCopy {
  return {
    form: 'nec',
    copy: 'B',
    taxYear: 2026,
    page: { width: 612, height: 792, unit: 'pt', origin: 'top-left' },
    title: 'Form 1099-NEC - Nonemployee Compensation (2026)',
    copyLabel: 'Copy B - For Recipient',
    labelFontSize: 6.5,
    valueFontSize: 10,
    fields: [
      field({ id: 'payer', label: "PAYER'S name", value: 'Acme Inc.\n1 Main St\nAustin, TX 78701', multiline: true, height: 90 }),
      field({ id: 'recipient_tin', label: "RECIPIENT'S TIN", value: '***-**-1234', kind: 'tin', y: 180 }),
      field({ id: 'box_nec_1', label: '1  Nonemployee compensation', value: '4,200.00', kind: 'amount', x: 336, width: 240, align: 'right' }),
      field({ id: 'box_nec_2', label: '2  Direct sales', kind: 'checkbox', checked: true, x: 336, y: 126, width: 240 }),
      field({ id: 'corrected', label: 'CORRECTED', kind: 'checkbox', checked: false, x: 336, y: 162, width: 100 }),
    ],
    blocks: [
      { id: 'legend', x: 36, y: 400, width: 540, fontSize: 8, lineHeight: 10, bold: true, paragraphs: ['This is important tax information.'] },
    ],
    footer: 'Form 1099-NEC (2026)  |  Copy B - For Recipient',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('renderForm1099Pdf', () => {
  it('draws one page per copy', async () => {
    const bytes = await renderForm1099Pdf([copy(), copy({ copy: 'C', copyLabel: 'Copy C - For Payer' })]);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getWidth()).toBe(612);
    expect(doc.getPage(0).getHeight()).toBe(792);
  });

  it('prints the values and captions of each field, the title and the footer', async () => {
    const drawText = vi.spyOn(PDFPage.prototype, 'drawText');
    await renderForm1099Pdf([copy()]);
    const printed = drawText.mock.calls.map(([text]) => text);
    expect(printed).toContain('Form 1099-NEC - Nonemployee Compensation (2026)');
    expect(printed).toContain('Copy B - For Recipient');
    expect(printed).toContain('***-**-1234');
    expect(printed).toContain('4,200.00');
    expect(printed).toContain('Acme Inc.');
    expect(printed).toContain('Austin, TX 78701');
    expect(printed).toContain('This is important tax information.');
    expect(printed).toContain('Form 1099-NEC (2026)  |  Copy B - For Recipient');
  });

  it('flips the y axis: a box near the top of the page is drawn near the top of the PDF', async () => {
    const drawRectangle = vi.spyOn(PDFPage.prototype, 'drawRectangle');
    await renderForm1099Pdf([copy({ fields: [field({ id: 'top', y: 90, height: 36 })], blocks: [] })]);
    const [options] = drawRectangle.mock.calls[0]!;
    expect(options?.y).toBe(792 - 90 - 36);
    expect(options?.x).toBe(36);
    expect(options?.width).toBe(300);
    expect(options?.height).toBe(36);
  });

  it('draws a cross in a checked checkbox and none in an unchecked one', async () => {
    const drawLine = vi.spyOn(PDFPage.prototype, 'drawLine');
    await renderForm1099Pdf([copy({ fields: [field({ id: 'a', kind: 'checkbox', checked: true })], blocks: [] })]);
    expect(drawLine).toHaveBeenCalledTimes(2);
    drawLine.mockClear();
    await renderForm1099Pdf([copy({ fields: [field({ id: 'b', kind: 'checkbox', checked: false })], blocks: [] })]);
    expect(drawLine).not.toHaveBeenCalled();
  });

  it('right-aligns amounts inside their box', async () => {
    const drawText = vi.spyOn(PDFPage.prototype, 'drawText');
    await renderForm1099Pdf([
      copy({ fields: [field({ id: 'amount', label: 'Amount', value: '1.00', kind: 'amount', x: 100, width: 200, align: 'right' })], blocks: [] }),
    ]);
    const call = drawText.mock.calls.find(([text]) => text === '1.00')!;
    const x = call[1]?.x ?? 0;
    // Drawn against the right edge of the box (x + width = 300), not at the left padding.
    expect(x).toBeGreaterThan(250);
    expect(x).toBeLessThan(300);
  });

  it('continues a long instruction block on a new page instead of cutting it off', async () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}. ${'Some instruction text that wraps. '.repeat(12)}`);
    const bytes = await renderForm1099Pdf([
      copy({ blocks: [{ id: 'instructions', x: 36, y: 400, width: 540, fontSize: 7, lineHeight: 8.5, paragraphs, paragraphGap: 4 }] }),
    ]);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it('does not fail on characters the standard fonts cannot draw', async () => {
    const bytes = await renderForm1099Pdf([copy({ fields: [field({ id: 'name', value: 'Łukasz Żółć 北京', label: 'Name' })], blocks: [] })]);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});

describe('text helpers', () => {
  it('printable replaces what the font cannot encode', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(printable(font, 'Zoë')).toBe('Zoë');
    expect(printable(font, 'a\nb')).toBe('a b');
    expect(printable(font, '北')).toBe('?');
  });

  it('wrapText wraps at the width, keeps line breaks and cuts words that do not fit a line', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const lines = wrapText(font, 'one two three four five six seven eight nine ten', 10, 80);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(font.widthOfTextAtSize(line, 10)).toBeLessThanOrEqual(80);

    expect(wrapText(font, 'first\nsecond', 10, 300)).toEqual(['first', 'second']);

    const cut = wrapText(font, 'Supercalifragilisticexpialidocious', 10, 60);
    expect(cut.length).toBeGreaterThan(1);
    expect(cut.join('')).toBe('Supercalifragilisticexpialidocious');
  });
});

describe('form1099PdfFilename', () => {
  it('names the form, the year, the recipient and the copies', () => {
    expect(form1099PdfFilename({ form: 'nec', taxYear: 2026, recipient: 'Acme, LLC', copies: ['B'] })).toBe('1099-NEC-2026-acme-llc-copy-B.pdf');
    expect(form1099PdfFilename({ form: 'misc', taxYear: 2025 })).toBe('1099-MISC-2025.pdf');
    expect(form1099PdfFilename({ form: 'nec', taxYear: 2026, copies: ['B', '1', '2', 'C'] })).toBe('1099-NEC-2026-copy-B-1-2-C.pdf');
  });
});
