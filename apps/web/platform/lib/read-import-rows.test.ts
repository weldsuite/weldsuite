import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { readImportRows } from './read-import-rows';

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

    it('keeps task keys, dates and hours as written', () => {
      const [row] = readImportRows(
        csv(
          'Key,Title,Start Date,Due Date,Estimated Hours\n' +
            '007,Release 2026.10,2026-05-01,2026-10-13 12:20:54.29676+00,4.50\n',
        ),
      );
      expect(row).toEqual({
        Key: '007',
        Title: 'Release 2026.10',
        'Start Date': '2026-05-01',
        'Due Date': '2026-10-13 12:20:54.29676+00',
        'Estimated Hours': '4.50',
      });
    });

    it('keeps long numbers and quoted separators as written', () => {
      const [row] = readImportRows(csv('Key,Title,Amount\n919740822531,123456789012345,"1,234.50"\n'));
      expect(row).toEqual({ Key: '919740822531', Title: '123456789012345', Amount: '1,234.50' });
    });

    it('reads a file that starts with a byte-order mark', () => {
      const [row] = readImportRows(csv('﻿Key,Title\nTASK-1,Set up repo\n'));
      expect(row).toEqual({ Key: 'TASK-1', Title: 'Set up repo' });
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
          ['phone', 'hours', 'due'],
          ['+919740822531', 12.5, new Date(Date.UTC(2026, 9, 13))],
        ]),
      );
      expect(row!.phone).toBe('+919740822531');
      expect(row!.hours).toBe('12.5');
      // A formatted date, not the 46308 serial behind it.
      expect(row!.due).toMatch(/^\d{1,2}\/\d{1,2}\/26$/);
    });
  });
});
