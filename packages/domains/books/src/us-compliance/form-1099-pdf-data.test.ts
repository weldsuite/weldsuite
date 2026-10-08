import { describe, it, expect } from 'vitest';
import {
  LETTER_PAGE,
  form1099PdfCopies,
  formatMoney,
  formatTin,
  maskTin,
  type Form1099PdfCopy,
  type Form1099PdfInput,
} from './form-1099-pdf-data';

const base: Form1099PdfInput = {
  form: 'nec',
  taxYear: 2026,
  payer: {
    name: 'Weld Test Co',
    nameLine2: 'DBA Weld Tools',
    address: { line1: '100 Main St', line2: 'Suite 4', city: 'Austin', state: 'TX', zip: '78701' },
    phone: '(512) 555-0100',
    tinType: 'ein',
    tin: '123456789',
  },
  recipient: {
    name: 'Jane Doe',
    businessName: 'Doe Design',
    address: { line1: '5 Elm Street', city: 'Dallas', state: 'TX', zip: '75001' },
    tinType: 'ssn',
    tinLast4: '6789',
    accountNumber: 'V-0001',
  },
  boxes: { nec_1: 2500, nec_4: 0 },
};

const fieldValue = (copy: Form1099PdfCopy, id: string): string => {
  const found = copy.fields.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no field ${id}`);
  return found.value;
};

function overlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('TIN formatting', () => {
  it('truncates a recipient TIN to the last four digits', () => {
    expect(maskTin('ssn', '6789')).toBe('***-**-6789');
    expect(maskTin('itin', '1234')).toBe('***-**-1234');
    expect(maskTin('ein', '4321')).toBe('**-***4321');
    expect(maskTin('ssn', '12')).toBe('***-**-**12');
  });

  it('formats a full TIN with its dashes', () => {
    expect(formatTin('ein', '123456789')).toBe('12-3456789');
    expect(formatTin('ssn', '123-45-6789')).toBe('123-45-6789');
    expect(formatTin('ssn', '12345')).toBe('12345');
  });

  it('formats money without a currency sign and leaves zero blank', () => {
    expect(formatMoney(2500)).toBe('2,500.00');
    expect(formatMoney(1234567.891)).toBe('1,234,567.89');
    expect(formatMoney(0)).toBe('');
    expect(formatMoney(undefined)).toBe('');
  });
});

describe('form1099PdfCopies', () => {
  it('lays out Copy B, 1, 2 and C by default', () => {
    const copies = form1099PdfCopies(base);
    expect(copies.map((copy) => copy.copy)).toEqual(['B', '1', '2', 'C']);
    expect(form1099PdfCopies({ ...base, copies: ['B'] })).toHaveLength(1);
    expect(copies[0]!.page).toEqual(LETTER_PAGE);
    expect(copies[0]!.title).toBe('Form 1099-NEC - Nonemployee Compensation (2026)');
  });

  it('prints the recipient TIN truncated and the payer TIN in full on every copy', () => {
    for (const copy of form1099PdfCopies(base)) {
      expect(fieldValue(copy, 'recipient_tin')).toBe('***-**-6789');
      expect(fieldValue(copy, 'payer_tin')).toBe('12-3456789');
      expect(JSON.stringify(copy)).not.toContain('123-45-6789');
    }
    const ein = form1099PdfCopies({ ...base, recipient: { ...base.recipient, tinType: 'ein', tinLast4: '4321' } });
    expect(fieldValue(ein[0]!, 'recipient_tin')).toBe('**-***4321');
  });

  it('fills the payer and recipient blocks and the amounts', () => {
    const [copyB] = form1099PdfCopies(base);
    expect(fieldValue(copyB!, 'payer')).toBe('Weld Test Co\nDBA Weld Tools\n100 Main St\nSuite 4\nAustin, TX 78701\n(512) 555-0100');
    expect(fieldValue(copyB!, 'recipient_name')).toBe('Jane Doe\nDoe Design');
    expect(fieldValue(copyB!, 'recipient_street')).toBe('5 Elm Street');
    expect(fieldValue(copyB!, 'recipient_place')).toBe('Dallas, TX 75001');
    expect(fieldValue(copyB!, 'account_number')).toBe('V-0001');
    expect(fieldValue(copyB!, 'box_nec_1')).toBe('2,500.00');
    expect(fieldValue(copyB!, 'box_nec_4')).toBe('');
    expect(fieldValue(copyB!, 'tax_year')).toBe('2026');
    expect(copyB!.fields.find((f) => f.id === 'box_nec_1')).toMatchObject({ kind: 'amount', align: 'right', box: 'nec_1' });
  });

  it('shows checkboxes, withholding and state boxes', () => {
    const [copyB] = form1099PdfCopies({
      ...base,
      directSales: true,
      corrected: true,
      boxes: { nec_1: 10000, nec_4: 2400 },
      states: [{ code: 'tx', payerStateNumber: '12-345', withheld: 5, income: 10000 }],
    });
    const checked = (id: string) => copyB!.fields.find((f) => f.id === id)?.checked;
    expect(checked('box_nec_2')).toBe(true);
    expect(checked('corrected')).toBe(true);
    expect(fieldValue(copyB!, 'box_nec_4')).toBe('2,400.00');
    expect(fieldValue(copyB!, 'state1_withheld')).toBe('5.00');
    expect(fieldValue(copyB!, 'state1_number')).toBe('TX 12-345');
    expect(fieldValue(copyB!, 'state1_income')).toBe('10,000.00');
    expect(fieldValue(copyB!, 'state2_income')).toBe('');
  });

  it('puts the negligence legend and the recipient instructions on Copy B only', () => {
    const copies = form1099PdfCopies(base);
    const [b, one, two, c] = copies;
    expect(b!.blocks.find((block) => block.id === 'legend')!.paragraphs[0]).toContain('negligence penalty');
    expect(b!.blocks.some((block) => block.id === 'instructions')).toBe(true);
    for (const copy of [one!, two!, c!]) {
      expect(copy.blocks.some((block) => block.id === 'instructions')).toBe(false);
      expect(copy.blocks.find((block) => block.id === 'legend')!.paragraphs[0]).not.toContain('negligence');
    }
    expect(one!.blocks[0]!.paragraphs[0]).toBe('For State Tax Department.');
    expect(two!.blocks[0]!.paragraphs[0]).toContain("recipient's state income tax return");
    expect(c!.copyLabel).toBe('Copy C - For Payer');
    expect(c!.footer).toContain('Copy C');
    const instructions = b!.blocks.find((block) => block.id === 'instructions')!.paragraphs.join(' ');
    expect(instructions).toContain('last four digits');
    expect(instructions).toContain('Box 4');
  });

  it('keeps every field on the page and no two fields on top of each other, for both forms', () => {
    for (const form of ['nec', 'misc'] as const) {
      const [copy] = form1099PdfCopies({
        ...base,
        form,
        boxes: { nec_1: 1, misc_1: 1 },
        states: [{ code: 'TX' }, { code: 'OK' }],
        fatca: true,
      });
      for (const f of copy!.fields) {
        expect(f.x).toBeGreaterThanOrEqual(36);
        expect(f.x + f.width).toBeLessThanOrEqual(576);
        expect(f.y).toBeGreaterThanOrEqual(36);
        expect(f.y + f.height).toBeLessThanOrEqual(copy!.page.height - 36);
      }
      const fields = copy!.fields;
      for (let i = 0; i < fields.length; i += 1) {
        for (let j = i + 1; j < fields.length; j += 1) {
          expect(overlap(fields[i]!, fields[j]!), `${fields[i]!.id} overlaps ${fields[j]!.id}`).toBe(false);
        }
      }
      const gridBottom = Math.max(...fields.map((f) => f.y + f.height));
      const legend = copy!.blocks.find((block) => block.id === 'legend')!;
      expect(legend.y).toBeGreaterThan(gridBottom);
    }
  });

  it('lays out the MISC boxes with their numbers and the FATCA and direct sales checkboxes', () => {
    const [copyB] = form1099PdfCopies({
      ...base,
      form: 'misc',
      boxes: { misc_1: 24000, misc_2: 10, misc_10: 600, misc_6: 2000 },
      directSales: false,
      fatca: true,
    });
    expect(copyB!.title).toBe('Form 1099-MISC - Miscellaneous Information (2026)');
    expect(fieldValue(copyB!, 'box_misc_1')).toBe('24,000.00');
    expect(fieldValue(copyB!, 'box_misc_10')).toBe('600.00');
    expect(copyB!.fields.find((f) => f.id === 'box_misc_13')).toMatchObject({ kind: 'checkbox', checked: true });
    expect(copyB!.fields.find((f) => f.id === 'box_misc_7')).toMatchObject({ kind: 'checkbox', checked: false });
    expect(copyB!.fields.filter((f) => f.box?.startsWith('misc_') && f.kind === 'amount').length).toBeGreaterThanOrEqual(12);
    expect(copyB!.fields.find((f) => f.id === 'box_misc_10')!.label).toBe('10  Gross proceeds paid to an attorney');
    const instructions = copyB!.blocks.find((block) => block.id === 'instructions')!.paragraphs.join(' ');
    expect(instructions).toContain('Box 14');
    expect(instructions).not.toContain('Box 13. If checked, consumer');
  });

  it('formats a foreign recipient address with its country', () => {
    const [copyB] = form1099PdfCopies({
      ...base,
      recipient: { ...base.recipient, address: { line1: '1 Rue X', city: 'Paris', state: '', zip: '75001', country: 'FR' } },
    });
    expect(fieldValue(copyB!, 'recipient_place')).toBe('Paris, 75001, FR');
  });
});
