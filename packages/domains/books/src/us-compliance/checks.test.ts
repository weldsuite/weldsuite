import { describe, it, expect } from 'vitest';
import {
  CHECK_LAYOUTS,
  CHECK_MAX_AMOUNT,
  LETTER_PAGE,
  MICR_SPEC,
  MICR_SYMBOLS,
  THREE_UP_FACE_HEIGHT,
  VOUCHER_FACE_HEIGHT,
  VOUCHER_STUB_HEIGHT,
  amountInWords,
  buildMicrFields,
  buildMicrLine,
  courtesyAmount,
  formatCheckNumber,
  fractionalDenominator,
  fractionalRouting,
  getCheckLayout,
  isCheckLayoutId,
  micrToFontLetters,
  nextCheckNumbers,
  validateMicrInput,
  type CheckFaceFields,
  type CheckLayoutId,
  type TextBox,
} from './checks';

describe('amount in words', () => {
  it('writes the legal line with cents as a fraction of 100', () => {
    expect(amountInWords(1234.56)).toBe('One thousand two hundred thirty-four and 56/100');
    expect(amountInWords(0)).toBe('Zero and 00/100');
    expect(amountInWords(0.99)).toBe('Zero and 99/100');
    expect(amountInWords(1)).toBe('One and 00/100');
    expect(amountInWords(5.05)).toBe('Five and 05/100');
  });

  it('handles the teens, tens and hundreds', () => {
    expect(amountInWords(11)).toBe('Eleven and 00/100');
    expect(amountInWords(19)).toBe('Nineteen and 00/100');
    expect(amountInWords(20)).toBe('Twenty and 00/100');
    expect(amountInWords(21)).toBe('Twenty-one and 00/100');
    expect(amountInWords(99)).toBe('Ninety-nine and 00/100');
    expect(amountInWords(100)).toBe('One hundred and 00/100');
    expect(amountInWords(101.01)).toBe('One hundred one and 01/100');
    expect(amountInWords(110)).toBe('One hundred ten and 00/100');
    expect(amountInWords(999)).toBe('Nine hundred ninety-nine and 00/100');
  });

  it('skips empty thousand groups and handles millions and billions', () => {
    expect(amountInWords(1000)).toBe('One thousand and 00/100');
    expect(amountInWords(1_000_000)).toBe('One million and 00/100');
    expect(amountInWords(1_001_001.01)).toBe('One million one thousand one and 01/100');
    expect(amountInWords(12_345_678.9)).toBe('Twelve million three hundred forty-five thousand six hundred seventy-eight and 90/100');
    expect(amountInWords(99_999_999.99)).toBe('Ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine and 99/100');
    expect(amountInWords(2_000_000_000)).toBe('Two billion and 00/100');
    expect(amountInWords(CHECK_MAX_AMOUNT)).toMatch(/^Nine hundred ninety-nine billion .* and 99\/100$/);
  });

  it('can add the currency word', () => {
    expect(amountInWords(1234.56, { currencyWord: true })).toBe('One thousand two hundred thirty-four and 56/100 dollars');
  });

  it('rejects amounts a check cannot carry', () => {
    expect(() => amountInWords(-1)).toThrow(RangeError);
    expect(() => amountInWords(Number.NaN)).toThrow(RangeError);
    expect(() => amountInWords(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => amountInWords(1_000_000_000_000)).toThrow(RangeError);
  });

  it('rounds float noise to the cent', () => {
    expect(amountInWords(0.1 + 0.2)).toBe('Zero and 30/100');
    expect(amountInWords(1.1 * 3)).toBe('Three and 30/100');
  });
});

describe('courtesy amount', () => {
  it('prints the protected numeric amount', () => {
    expect(courtesyAmount(1234.56)).toBe('$**1,234.56');
    expect(courtesyAmount(5)).toBe('$**5.00');
    expect(courtesyAmount(1234.56, { symbol: false, protect: 0 })).toBe('1,234.56');
    expect(courtesyAmount(1_000_000, { protect: 3 })).toBe('$***1,000,000.00');
    expect(() => courtesyAmount(-1)).toThrow(RangeError);
  });
});

describe('MICR line', () => {
  it('uses the E-13B symbols from the Unicode OCR block', () => {
    expect(MICR_SYMBOLS.transit.codePointAt(0)).toBe(0x2446);
    expect(MICR_SYMBOLS.amount.codePointAt(0)).toBe(0x2447);
    expect(MICR_SYMBOLS.onUs.codePointAt(0)).toBe(0x2448);
    expect(MICR_SYMBOLS.dash.codePointAt(0)).toBe(0x2449);
  });

  it('builds the business check line: auxiliary on-us, transit, on-us', () => {
    const line = buildMicrLine({ routingNumber: '021000021', accountNumber: '123456789', checkNumber: 123 });
    expect(line).toBe('⑈000123⑈ ⑆021000021⑆ 123456789⑈');
    expect(line).toBe(`⑈000123⑈ ⑆021000021⑆ 123456789⑈`);
  });

  it('puts the check number after the account on a personal check', () => {
    const line = buildMicrLine({ routingNumber: '021000021', accountNumber: '123456789', checkNumber: '45', layout: 'personal', checkNumberWidth: 4 });
    expect(line).toBe('⑆021000021⑆ 123456789⑈ 0045');
  });

  it('turns hyphens and drops spaces in the account number', () => {
    expect(buildMicrLine({ routingNumber: '121000358', accountNumber: '123-456 78', checkNumber: 1 })).toBe('⑈000001⑈ ⑆121000358⑆ 123⑉45678⑈');
  });

  it('splits the line into the three fields', () => {
    expect(buildMicrFields({ routingNumber: '071000013', accountNumber: '987654', checkNumber: 7 })).toEqual({
      auxOnUs: '⑈000007⑈',
      transit: '⑆071000013⑆',
      onUs: '987654⑈',
    });
    expect(buildMicrFields({ routingNumber: '071000013', accountNumber: '987654', checkNumber: 7, layout: 'personal' }).auxOnUs).toBe('');
  });

  it('rejects a bad routing number, account or check number', () => {
    expect(validateMicrInput({ routingNumber: '021000022', accountNumber: '1', checkNumber: 1 })).toEqual(['The routing number fails the ABA checksum']);
    expect(validateMicrInput({ routingNumber: '1234', accountNumber: '1', checkNumber: 1 })).toEqual(['The routing number must be 9 digits']);
    expect(validateMicrInput({ routingNumber: '021000021', accountNumber: 'AB12', checkNumber: 1 })).toHaveLength(1);
    expect(validateMicrInput({ routingNumber: '021000021', accountNumber: '-', checkNumber: 1 })).toHaveLength(1);
    expect(validateMicrInput({ routingNumber: '021000021', accountNumber: '1'.repeat(19), checkNumber: 1 })).toHaveLength(1);
    expect(validateMicrInput({ routingNumber: '021000021', accountNumber: '1', checkNumber: 'A1' })).toHaveLength(1);
    expect(validateMicrInput({ routingNumber: '021000021', accountNumber: '1', checkNumber: 1 })).toEqual([]);
    expect(() => buildMicrLine({ routingNumber: '021000022', accountNumber: '1', checkNumber: 1 })).toThrow(RangeError);
  });

  it('maps the symbols to MICR font letters', () => {
    expect(micrToFontLetters('⑈000123⑈ ⑆021000021⑆ 123⑉456⑈ ⑇')).toBe('C000123C A021000021A 123D456C B');
  });
});

describe('fractional routing number', () => {
  it('joins the bank\'s numerator and the first four routing digits', () => {
    expect(fractionalRouting('121000358', '90-3589')).toBe('90-3589/1210');
    expect(fractionalRouting('021000021', '60-2')).toBe('60-2/0210');
    expect(fractionalDenominator('121000358')).toBe('1210');
  });

  it('returns null without a numerator and rejects malformed input', () => {
    expect(fractionalRouting('121000358', null)).toBeNull();
    expect(fractionalRouting('121000358', '')).toBeNull();
    expect(() => fractionalRouting('121000358', '9035')).toThrow(RangeError);
    expect(() => fractionalRouting('1210', '90-3589')).toThrow(RangeError);
    expect(() => fractionalDenominator('12')).toThrow(RangeError);
  });
});

describe('check numbers', () => {
  it('counts forward from the start', () => {
    expect(nextCheckNumbers(1001, 3)).toEqual([1001, 1002, 1003]);
    expect(nextCheckNumbers(5, 0)).toEqual([]);
    expect(formatCheckNumber(123)).toBe('000123');
    expect(formatCheckNumber(123, 4)).toBe('0123');
  });

  it('rejects invalid starts and counts', () => {
    expect(() => nextCheckNumbers(-1, 1)).toThrow(RangeError);
    expect(() => nextCheckNumbers(1.5, 1)).toThrow(RangeError);
    expect(() => nextCheckNumbers(1, -1)).toThrow(RangeError);
    expect(() => nextCheckNumbers(1, 10_001)).toThrow(RangeError);
  });
});

function boxes(fields: CheckFaceFields): Array<[string, TextBox]> {
  return Object.entries(fields).filter((entry): entry is [string, TextBox] => 'fontSize' in (entry[1] as object));
}

describe('check layouts', () => {
  it('lists the four layouts', () => {
    expect(CHECK_LAYOUTS.map((l) => l.id)).toEqual(['voucher_top', 'voucher_middle', 'voucher_bottom', 'three_per_page']);
    expect(isCheckLayoutId('voucher_top')).toBe(true);
    expect(isCheckLayoutId('wallet')).toBe(false);
  });

  it('fills a Letter page exactly with a check and two stubs', () => {
    expect(LETTER_PAGE).toEqual({ width: 612, height: 792 });
    expect(VOUCHER_FACE_HEIGHT + 2 * VOUCHER_STUB_HEIGHT).toBe(792);
    expect(3 * THREE_UP_FACE_HEIGHT).toBe(792);
  });

  it('puts the check at the top, middle or bottom', () => {
    const top = getCheckLayout('voucher_top');
    expect(top.faces.map((f) => [f.top, f.height])).toEqual([[0, 252]]);
    expect(top.vouchers.map((v) => [v.top, v.height])).toEqual([[252, 270], [522, 270]]);
    const middle = getCheckLayout('voucher_middle');
    expect(middle.faces.map((f) => f.top)).toEqual([270]);
    expect(middle.vouchers.map((v) => v.top)).toEqual([0, 522]);
    const bottom = getCheckLayout('voucher_bottom');
    expect(bottom.faces.map((f) => f.top)).toEqual([540]);
    expect(bottom.vouchers.map((v) => v.top)).toEqual([0, 270]);
  });

  it('has three checks and no stubs on a three-per-page sheet', () => {
    const layout = getCheckLayout('three_per_page');
    expect(layout.faces.map((f) => [f.top, f.height])).toEqual([[0, 264], [264, 264], [528, 264]]);
    expect(layout.vouchers).toEqual([]);
  });

  it('covers the page with no overlap for every layout', () => {
    for (const { id } of CHECK_LAYOUTS) {
      const layout = getCheckLayout(id as CheckLayoutId);
      const sections = [...layout.faces, ...layout.vouchers].sort((a, b) => a.top - b.top);
      let cursor = 0;
      for (const section of sections) {
        expect(section.top, id).toBe(cursor);
        cursor += section.height;
      }
      expect(cursor, id).toBe(792);
    }
  });

  it('keeps every text box on the page and inside its check', () => {
    for (const { id } of CHECK_LAYOUTS) {
      for (const face of getCheckLayout(id as CheckLayoutId).faces) {
        for (const [name, box] of boxes(face.fields)) {
          expect(box.x, `${id} ${name}`).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width, `${id} ${name}`).toBeLessThanOrEqual(612);
          expect(box.y, `${id} ${name}`).toBeGreaterThan(face.top);
          expect(box.y, `${id} ${name}`).toBeLessThan(face.top + face.height);
        }
      }
    }
  });

  it('places the MICR line in the clear band at the standard positions', () => {
    const face = getCheckLayout('voucher_top').faces[0] as ReturnType<typeof getCheckLayout>['faces'][number];
    const { micrAuxOnUs, micrTransit, micrOnUs } = face.fields;
    // 3/16 inch above the bottom edge.
    expect(micrTransit.y).toBe(252 - 13.5);
    expect(new Set([micrAuxOnUs.y, micrTransit.y, micrOnUs.y]).size).toBe(1);
    // The clear band is the bottom 5/8 inch.
    expect(micrTransit.y).toBeGreaterThan(252 - 45);
    // Transit field: positions 33-43, 11 characters of 9 points.
    expect(micrTransit).toMatchObject({ x: 202.5, width: 99, align: 'left', font: 'micr', fontSize: 12 });
    // On-us field: positions 14-32, ending 139.5 points from the right edge; auxiliary on-us ends left of the transit field.
    expect(micrOnUs.x + micrOnUs.width).toBe(612 - 139.5);
    expect(micrOnUs.x).toBe(micrTransit.x + micrTransit.width);
    expect(micrAuxOnUs.x + micrAuxOnUs.width).toBeLessThan(micrTransit.x);
    // A 6-digit check number and the longest account fit their fields.
    expect(buildMicrFields({ routingNumber: '021000021', accountNumber: '1'.repeat(18), checkNumber: 123456 }).onUs.length * MICR_SPEC.pitch).toBeLessThanOrEqual(micrOnUs.width);
    expect(buildMicrFields({ routingNumber: '021000021', accountNumber: '1', checkNumber: 123456 }).auxOnUs.length * MICR_SPEC.pitch).toBeLessThanOrEqual(micrAuxOnUs.width);
    expect('⑆021000021⑆'.length * MICR_SPEC.pitch).toBe(micrTransit.width);
  });

  it('puts the MICR line 3/16 inch above the bottom of each check', () => {
    for (const face of getCheckLayout('three_per_page').faces) {
      expect(face.fields.micrTransit.y).toBe(face.top + face.height - 13.5);
    }
  });

  it('shifts text with the alignment offsets and the MICR line separately', () => {
    const base = getCheckLayout('voucher_top').faces[0]?.fields as CheckFaceFields;
    const shifted = getCheckLayout('voucher_top', { dx: 4, dy: -2, micrDx: 1.5, micrDy: 3 }).faces[0]?.fields as CheckFaceFields;
    expect(shifted.payee.x).toBe(base.payee.x + 4);
    expect(shifted.payee.y).toBe(base.payee.y - 2);
    expect(shifted.signatureLine.x1).toBe(base.signatureLine.x1 + 4);
    expect(shifted.micrTransit.x).toBe(base.micrTransit.x + 1.5);
    expect(shifted.micrTransit.y).toBe(base.micrTransit.y + 3);
    // Text offsets do not move the MICR line.
    expect(getCheckLayout('voucher_top', { dx: 4, dy: 4 }).faces[0]?.fields.micrTransit).toEqual(base.micrTransit);
  });

  it('describes the voucher stubs', () => {
    for (const voucher of getCheckLayout('voucher_top').vouchers) {
      const table = voucher.fields.table;
      expect(table.maxRows).toBe(Math.floor(table.height / table.rowHeight));
      expect(table.maxRows).toBeGreaterThanOrEqual(10);
      expect(table.y + table.height).toBeLessThan(voucher.top + voucher.height);
      expect(table.columns.map((c) => c.key)).toEqual(['date', 'reference', 'description', 'amount']);
      const last = table.columns.at(-1);
      expect((last?.x ?? 0) + (last?.width ?? 0)).toBeLessThanOrEqual(576);
    }
  });

  it('rejects an unknown layout', () => {
    expect(() => getCheckLayout('wallet' as CheckLayoutId)).toThrow(RangeError);
  });
});
