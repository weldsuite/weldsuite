import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { readImportRows } from './import-file';

const csv = (text: string) => new TextEncoder().encode(text);

function xlsx(rows: unknown[][]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

describe('readImportRows', () => {
  describe('CSV', () => {
    it('keeps phone numbers exactly as written', () => {
      const rows = readImportRows(
        csv('name,phone\neliaz asulin,+13172235170\nwysh,+919740822531\nVlad,+447580424472\nPiet,0612345678\n'),
      );
      expect(rows.map((r) => r.phone)).toEqual(['+13172235170', '+919740822531', '+447580424472', '0612345678']);
    });

    it('keeps other number- and date-like text as written', () => {
      const [row] = readImportRows(csv('code,amount,created_at\n007,"1,234.50",2026-10-13 12:20:54.29676+00\n'));
      expect(row).toEqual({ code: '007', amount: '1,234.50', created_at: '2026-10-13 12:20:54.29676+00' });
    });

    it('fills missing cells and skips blank rows', () => {
      expect(readImportRows(csv('name,phone\nAvery,\n\n,+18259946158\n'))).toEqual([
        { name: 'Avery', phone: '' },
        { name: '', phone: '+18259946158' },
      ]);
    });
  });

  describe('Excel', () => {
    it('prints a phone stored as a number with all its digits', () => {
      const [row] = readImportRows(xlsx([['phone'], [919740822531]]));
      expect(row!.phone).toBe('919740822531');
    });

    it('still reads text, decimals and dates', () => {
      const [row] = readImportRows(
        xlsx([
          ['phone', 'amount', 'born'],
          ['+919740822531', 12.5, new Date(Date.UTC(2026, 9, 13))],
        ]),
      );
      expect(row!.phone).toBe('+919740822531');
      expect(row!.amount).toBe('12.5');
      // A formatted date, not the 46308 serial behind it.
      expect(row!.born).toMatch(/^\d{1,2}\/\d{1,2}\/26$/);
    });
  });
});
