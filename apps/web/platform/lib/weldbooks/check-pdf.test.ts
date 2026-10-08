import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { en } from '@weldsuite/i18n/locales/en';
import type { CheckPrintData, VoucherRow } from '@/lib/api/domains/weldbooks-payment-runs';
import { makeCheck, makePrintData } from '@/app/weldbooks/payment-runs/test-utils';
import { getCheckLayout } from './check-layout';
import {
  planAlignmentTestPdf,
  planChecksPdf,
  renderAlignmentTestPdf,
  renderChecksPdf,
  usAmount,
  usDate,
  type CheckPdfLabels,
  type PdfOp,
  type TextMetrics,
  type TextOp,
} from './check-pdf';

const labels: CheckPdfLabels = { ...en.weldbooksUs.payments.checkPdf };

/** Every character is half its font size wide, and nothing is unencodable. */
const metrics: TextMetrics = {
  width: (_font, size, text) => text.length * size * 0.5,
  clean: (_font, text) => text,
};

const texts = (ops: readonly PdfOp[], page = 0): TextOp[] => ops.filter((op): op is TextOp => op.kind === 'text' && op.page === page);
const textsOf = (ops: readonly PdfOp[], page = 0): string[] => texts(ops, page).map((op) => op.text);

function twoChecks(options: Parameters<typeof makePrintData>[1] = {}): CheckPrintData {
  return makePrintData([makeCheck('001001', 'Acme Supplies', '100.00'), makeCheck('001002', 'Brightline LLC', '250.50')], options);
}

describe('planChecksPdf on preprinted stock', () => {
  it('draws the variable fields of a check at the positions of the layout', () => {
    const data = twoChecks();
    const plan = planChecksPdf({ ...data, checks: [data.checks[0]!] }, labels, metrics);
    const face = data.layout.faces[0]!.fields;

    const date = texts(plan.ops).find((op) => op.text === '10/09/2026' && op.y === face.date.y)!;
    expect(date).toBeDefined();
    // Right-aligned in its box: the text ends where the box ends.
    expect(date.x + date.text.length * date.size * 0.5).toBeCloseTo(face.date.x + face.date.width);

    const payee = texts(plan.ops).find((op) => op.text === 'Acme Supplies' && op.y === face.payee.y)!;
    expect(payee.x).toBe(face.payee.x);
    expect(payee.font).toBe('helvetica-bold');

    expect(texts(plan.ops).find((op) => op.text === '$**100.00')?.y).toBe(face.amount.y);
    expect(texts(plan.ops).find((op) => op.text === 'One hundred and 00/100')?.y).toBe(face.amountWords.y);
    expect(texts(plan.ops).find((op) => op.text === 'Bill INV-1')?.y).toBe(face.memo.y);
    // The address block sits under the payee, a line at a time.
    const lines = texts(plan.ops).filter((op) => op.text === '1 Main St' || op.text === 'Austin, TX 78701');
    expect(lines.map((l) => l.y)).toEqual([face.payeeAddress.y, face.payeeAddress.y + (face.payeeAddress.lineHeight ?? 0)]);
  });

  it('does not draw what the stock already has: payer, bank, labels, check number, signature line, MICR', () => {
    const data = twoChecks();
    const plan = planChecksPdf({ ...data, checks: [data.checks[0]!] }, labels, metrics);
    const face = data.layout.faces[0]!;
    const onFace = texts(plan.ops)
      .filter((op) => op.y <= face.top + face.height)
      .map((op) => op.text);
    for (const absent of ['Acme Holdings LLC', 'First Bank', 'DATE', 'DOLLARS', 'MEMO', 'VOID AFTER 90 DAYS', 'Authorized signature', '90-7162/0210', '001001']) {
      expect(onFace, absent).not.toContain(absent);
    }
    expect(plan.ops.some((op) => op.kind === 'line' && op.y1 < face.height)).toBe(false);
    expect(plan.ops.some((op) => op.kind === 'rect' && op.y < face.height)).toBe(false);
    expect(plan.micrSkipped).toBe(false);
  });

  it('draws both voucher stubs under the check with the bills it pays', () => {
    const data = twoChecks();
    const plan = planChecksPdf({ ...data, checks: [data.checks[0]!] }, labels, metrics);
    const [first, second] = data.layout.vouchers;
    const onStub = (top: number, height: number) => texts(plan.ops).filter((op) => op.y > top && op.y < top + height);

    for (const stub of [first!, second!]) {
      const drawn = onStub(stub.top, stub.height).map((op) => op.text);
      expect(drawn).toEqual(expect.arrayContaining(['Acme Holdings LLC', 'PAYMENT DETAILS', 'Acme Supplies', '10/09/2026', 'No. 001001', 'INV-1', '09/01/2026', '100.00', 'TOTAL']));
    }
    // The first table row's amount is right-aligned in the amount column.
    const row = texts(plan.ops).find((op) => op.text === '100.00' && op.y === first!.fields.table.y + first!.fields.table.rowHeight - 3)!;
    const amountColumn = first!.fields.table.columns.find((c) => c.key === 'amount')!;
    expect(row.x + row.text.length * row.size * 0.5).toBeCloseTo(amountColumn.x + amountColumn.width);
  });

  it('makes one page per check on a layout with stubs', () => {
    const plan = planChecksPdf(twoChecks(), labels, metrics);
    expect(plan.pageCount).toBe(2);
    expect(plan.checkNumbers).toEqual(['001001', '001002']);
    expect(textsOf(plan.ops, 0)).toContain('Acme Supplies');
    expect(textsOf(plan.ops, 0)).not.toContain('Brightline LLC');
    expect(textsOf(plan.ops, 1)).toContain('Brightline LLC');
  });

  it('puts three checks on a page on the three-up layout, down the page, without stubs', () => {
    const checks = ['1', '2', '3', '4'].map((n) => makeCheck(`00100${n}`, `Payee ${n}`, '10.00'));
    const data = makePrintData(checks, { layout: 'three_per_page' });
    const plan = planChecksPdf(data, labels, metrics);
    expect(plan.pageCount).toBe(2);

    const payeeY = (name: string, page: number) => texts(plan.ops, page).find((op) => op.text === name)?.y;
    const faces = data.layout.faces;
    expect(payeeY('Payee 1', 0)).toBe(faces[0]!.fields.payee.y);
    expect(payeeY('Payee 2', 0)).toBe(faces[1]!.fields.payee.y);
    expect(payeeY('Payee 3', 0)).toBe(faces[2]!.fields.payee.y);
    expect(payeeY('Payee 4', 1)).toBe(faces[0]!.fields.payee.y);
    expect(textsOf(plan.ops)).not.toContain('PAYMENT DETAILS');
  });

  it('follows the alignment offsets that came with the layout', () => {
    const data = twoChecks();
    const shifted = { ...data, layout: getCheckLayout('voucher_top', { dx: 10, dy: 5 }) };
    const plain = planChecksPdf({ ...data, checks: [data.checks[0]!] }, labels, metrics);
    const moved = planChecksPdf({ ...shifted, checks: [data.checks[0]!] }, labels, metrics);
    const payee = (plan: typeof plain) => texts(plan.ops).find((op) => op.text === 'Acme Supplies' && op.y < 252)!;
    expect(payee(moved).x - payee(plain).x).toBe(10);
    expect(payee(moved).y - payee(plain).y).toBe(5);
  });

  it('says how many bills do not fit on a stub instead of dropping them silently', () => {
    const rows: VoucherRow[] = Array.from({ length: 30 }, (_, i) => ({
      date: '2026-09-01',
      reference: `INV-${i + 1}`,
      description: null,
      amount: '1.00',
      billTotal: '1.00',
      discount: null,
    }));
    const data = makePrintData([makeCheck('001001', 'Acme Supplies', '30.00', { voucher: { rows, grossTotal: '30.00', backupWithholding: null, total: '30.00' } })]);
    const maxRows = data.layout.vouchers[0]!.fields.table.maxRows;
    const plan = planChecksPdf(data, labels, metrics);
    expect(textsOf(plan.ops)).toContain(`+${30 - (maxRows - 1)} more`);
    expect(textsOf(plan.ops)).not.toContain(`INV-${maxRows}`);
    expect(textsOf(plan.ops)).toContain(`INV-${maxRows - 1}`);
  });

  describe('a check with backup withholding', () => {
    const withheld = () =>
      makePrintData([
        makeCheck('001001', 'Oscar Consulting', '2280.00', {
          amountInWords: 'Two thousand two hundred eighty and 00/100',
          courtesyAmount: '$**2,280.00',
          grossAmount: '3000.00',
          backupWithholdingAmount: '720.00',
          voucher: {
            rows: [{ date: '2026-09-01', reference: 'O-1', description: null, amount: '3000.00', billTotal: '3000.00', discount: null }],
            grossTotal: '3000.00',
            backupWithholding: '720.00',
            total: '2280.00',
          },
        }),
      ]);

    it('writes the check for the net: the amount box and the words are what the server sent', () => {
      const data = withheld();
      const plan = planChecksPdf(data, labels, metrics);
      const face = data.layout.faces[0]!.fields;
      expect(texts(plan.ops).find((op) => op.y === face.amount.y && op.text === '$**2,280.00')).toBeDefined();
      expect(texts(plan.ops).find((op) => op.y === face.amountWords.y)?.text).toBe('Two thousand two hundred eighty and 00/100');
      expect(textsOf(plan.ops)).not.toContain('$**3,000.00');
    });

    it('lists the gross, the withholding as a deduction and the net on both stubs, the net where the total always is', () => {
      const data = withheld();
      const plan = planChecksPdf(data, labels, metrics);
      for (const stub of data.layout.vouchers) {
        const total = stub.fields.total.y;
        const onStub = texts(plan.ops).filter((op) => op.y > stub.top && op.y < stub.top + stub.height);
        const at = (text: string) => onStub.find((op) => op.text === text);
        expect(at('3,000.00')?.y).toBe(stub.fields.table.y + stub.fields.table.rowHeight - 3);
        const gross = onStub.find((op) => op.text === '3,000.00' && op.y === total - 24);
        expect(gross).toBeDefined();
        expect(at('-720.00')?.y).toBe(total - 12);
        expect(at('2,280.00')?.y).toBe(total);
        expect(onStub.find((op) => op.text === 'GROSS')?.y).toBe(total - 24);
        expect(onStub.find((op) => op.text === 'BACKUP WITHHOLDING')?.y).toBe(total - 12);
        expect(onStub.find((op) => op.text === 'NET PAID')?.y).toBe(total);
        expect(onStub.find((op) => op.text === 'TOTAL')).toBeUndefined();
      }
    });

    it('right-aligns the three amounts in the amount column', () => {
      const data = withheld();
      const plan = planChecksPdf(data, labels, metrics);
      const stub = data.layout.vouchers[0]!;
      const end = stub.fields.total.x + stub.fields.total.width;
      for (const text of ['-720.00', '2,280.00']) {
        const op = texts(plan.ops).find((o) => o.text === text && o.y > stub.top && o.y < stub.top + stub.height)!;
        expect(op.x + op.text.length * op.size * 0.5).toBeCloseTo(end);
      }
    });

    it('gives up two table rows for the extra lines, and says how many bills did not fit', () => {
      const rows: VoucherRow[] = Array.from({ length: 30 }, (_, i) => ({
        date: '2026-09-01',
        reference: `INV-${i + 1}`,
        description: null,
        amount: '100.00',
        billTotal: '100.00',
        discount: null,
      }));
      const data = makePrintData([
        makeCheck('001001', 'Oscar Consulting', '2280.00', {
          grossAmount: '3000.00',
          backupWithholdingAmount: '720.00',
          voucher: { rows, grossTotal: '3000.00', backupWithholding: '720.00', total: '2280.00' },
        }),
      ]);
      const maxRows = data.layout.vouchers[0]!.fields.table.maxRows;
      const plan = planChecksPdf(data, labels, metrics);
      const shown = maxRows - 2 - 1;
      expect(textsOf(plan.ops)).toContain(`INV-${shown}`);
      expect(textsOf(plan.ops)).not.toContain(`INV-${shown + 1}`);
      expect(textsOf(plan.ops)).toContain(`+${30 - shown} more`);
    });

    it('keeps the gross and net lines clear of the last bill row', () => {
      const data = withheld();
      const plan = planChecksPdf(data, labels, metrics);
      const stub = data.layout.vouchers[0]!;
      const lastRow = stub.fields.table.y + (stub.fields.table.maxRows - 2) * stub.fields.table.rowHeight - 3;
      expect(stub.fields.total.y - 24).toBeGreaterThan(lastRow);
      expect(plan.pageCount).toBe(1);
    });

    it('draws the same way on blank stock and still leaves the MICR band empty', () => {
      const blank = { ...withheld(), settings: { ...withheld().settings, printMicr: true } };
      const plan = planChecksPdf(blank, labels, metrics);
      expect(plan.micrSkipped).toBe(true);
      expect(textsOf(plan.ops)).toEqual(expect.arrayContaining(['NET PAID', '$**2,280.00']));
    });
  });

  it('shrinks a long payee name to fit its box', () => {
    const name = 'A very long payee name incorporated and sons of the great plains limited liability company';
    const data = makePrintData([makeCheck('001001', name, '10.00')]);
    const plan = planChecksPdf(data, labels, metrics);
    const face = data.layout.faces[0]!.fields;
    const payee = texts(plan.ops).find((op) => op.y === face.payee.y && op.text.startsWith('A very long'))!;
    expect(payee.size).toBeLessThan(face.payee.fontSize);
    expect(payee.text.length * payee.size * 0.5).toBeLessThanOrEqual(face.payee.width);
  });
});

describe('planChecksPdf on blank stock with MICR', () => {
  const data = () => twoChecks({ printMicr: true });

  it('draws the whole check face: payer, bank, labels, number, fractional routing, amount box and signature line', () => {
    const blank = data();
    const plan = planChecksPdf({ ...blank, checks: [blank.checks[0]!] }, labels, metrics);
    const drawn = textsOf(plan.ops);
    for (const present of ['Acme Holdings LLC', 'First Bank', '1 Bank Plaza', 'DATE', 'DOLLARS', 'MEMO', 'VOID AFTER 90 DAYS', 'Authorized signature', '001001', '90-7162/0210']) {
      expect(drawn, present).toContain(present);
    }
    // The two-line payee label is stacked on two rows.
    expect(drawn).toEqual(expect.arrayContaining(['PAY TO THE', 'ORDER OF']));
    const face = blank.layout.faces[0]!.fields;
    expect(plan.ops.some((op) => op.kind === 'rect' && op.x === face.amountBox.x && op.y === face.amountBox.y)).toBe(true);
    expect(plan.ops.some((op) => op.kind === 'line' && op.y1 === face.signatureLine.y1 && op.x1 === face.signatureLine.x1)).toBe(true);
  });

  it('leaves the MICR band empty and says so, even when the server sent the MICR data', () => {
    const blank = data();
    const micr = {
      line: '⑈001001⑈ ⑆021000021⑆ 123456789⑈',
      fields: { auxOnUs: '⑈001001⑈', transit: '⑆021000021⑆', onUs: '123456789⑈' },
      fieldsAsFontLetters: { auxOnUs: 'C001001C', transit: 'A021000021A', onUs: '123456789C' },
    };
    const withMicr = { ...blank, checks: blank.checks.map((c) => ({ ...c, micr })) };
    const plan = planChecksPdf(withMicr, labels, metrics);

    expect(plan.micrSkipped).toBe(true);
    // Neither the routing number nor the account number reaches the PDF.
    const drawn = textsOf(plan.ops).join(' ');
    expect(drawn).not.toContain('021000021');
    expect(drawn).not.toContain('123456789');
    expect(drawn).not.toContain('⑆');
    const micrTop = withMicr.layout.faces[0]!.fields.micrTransit.y - 12;
    expect(texts(plan.ops).filter((op) => op.y > micrTop && op.y <= withMicr.layout.faces[0]!.fields.micrTransit.y)).toEqual([]);
  });

  it('has nothing to flag when there are no checks', () => {
    expect(planChecksPdf({ ...data(), checks: [] }, labels, metrics)).toMatchObject({ micrSkipped: false, pageCount: 0, ops: [] });
  });
});

describe('planAlignmentTestPdf', () => {
  it('draws a box at every field of a check face, the MICR fields dashed, and a ruler', () => {
    const layout = getCheckLayout('voucher_top', { dx: 4, dy: -2 });
    const plan = planAlignmentTestPdf(layout, labels, metrics, { alignment: { dx: 4, dy: -2 } });
    const face = layout.faces[0]!.fields;

    expect(plan.pageCount).toBe(1);
    // The payee box starts where the payee field does.
    expect(plan.ops.some((op) => op.kind === 'rect' && op.x === face.payee.x && !op.dashed)).toBe(true);
    // Three dashed MICR boxes, at the MICR positions.
    const micrBoxes = plan.ops.filter((op) => op.kind === 'rect' && op.dashed && op.thickness > 0.5);
    expect(micrBoxes.map((b) => b.kind === 'rect' && b.x).sort()).toEqual([face.micrAuxOnUs.x, face.micrOnUs.x, face.micrTransit.x].sort());
    // Ruler numbers: 1 inch, 2 inches...
    expect(textsOf(plan.ops)).toEqual(expect.arrayContaining(['1', '2', '3']));
  });

  it('prints the offsets in use', () => {
    const plan = planAlignmentTestPdf(getCheckLayout('voucher_top'), labels, metrics, { alignment: { dx: 4, dy: -2, micrDx: 1, micrDy: 0 } });
    expect(textsOf(plan.ops)).toContain('Shift: right 4, down -2, MICR right 1, MICR down 0 (points)');
  });

  it('covers every stub and face of a three-up layout', () => {
    const layout = getCheckLayout('three_per_page');
    const plan = planAlignmentTestPdf(layout, labels, metrics);
    const outlines = plan.ops.filter((op) => op.kind === 'rect' && op.dashed && op.thickness === 0.5);
    expect(outlines).toHaveLength(3);
  });
});

describe('formatting', () => {
  it('formats dates and amounts the way a US check shows them', () => {
    expect(usDate('2026-10-09')).toBe('10/09/2026');
    expect(usDate('2026-10-09T00:00:00.000Z')).toBe('10/09/2026');
    expect(usDate(null)).toBe('');
    expect(usAmount('1234.5')).toBe('1,234.50');
    expect(usAmount('abc')).toBe('');
  });
});

describe('renderChecksPdf', () => {
  it('makes a Letter PDF with a page per check', async () => {
    const result = await renderChecksPdf(twoChecks(), labels);
    const pdf = await PDFDocument.load(result.bytes);
    expect(pdf.getPageCount()).toBe(2);
    expect(result.pageCount).toBe(2);
    expect(pdf.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(result.micrSkipped).toBe(false);
  });

  it('makes a page for three checks on the three-up layout', async () => {
    const checks = ['1', '2', '3'].map((n) => makeCheck(`00100${n}`, `Payee ${n}`, '10.00'));
    const pdf = await PDFDocument.load((await renderChecksPdf(makePrintData(checks, { layout: 'three_per_page' }), labels)).bytes);
    expect(pdf.getPageCount()).toBe(1);
  });

  it('draws names the standard fonts cannot encode without failing', async () => {
    const data = makePrintData([makeCheck('001001', 'Café Müller 株式会社   LLC', '10.00')], { printMicr: true });
    const result = await renderChecksPdf(data, labels);
    expect(result.bytes.byteLength).toBeGreaterThan(500);
    expect(result.micrSkipped).toBe(true);
  });

  it('makes the alignment test page', async () => {
    const result = await renderAlignmentTestPdf(getCheckLayout('voucher_middle'), labels, { alignment: { dy: 3 } });
    const pdf = await PDFDocument.load(result.bytes);
    expect(pdf.getPageCount()).toBe(1);
  });
});
