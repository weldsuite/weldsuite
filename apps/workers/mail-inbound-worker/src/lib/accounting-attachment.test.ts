import { describe, expect, it } from 'vitest';
import { accountingAttachmentType } from './accounting-attachment';

describe('accountingAttachmentType', () => {
  it('keeps PDFs and images', () => {
    expect(accountingAttachmentType({ contentType: 'application/pdf', fileName: 'inv.pdf' })).toBe('application/pdf');
    expect(accountingAttachmentType({ contentType: 'image/jpeg', fileName: 'receipt.jpg' })).toBe('image/jpeg');
  });

  it('drops parameters and normalises case', () => {
    expect(
      accountingAttachmentType({ contentType: 'Application/PDF; name="inv.pdf"', fileName: 'inv.pdf' }),
    ).toBe('application/pdf');
  });

  it('files an untyped .pdf as a PDF', () => {
    expect(accountingAttachmentType({ contentType: 'application/octet-stream', fileName: 'Factuur 2026-104.PDF' })).toBe(
      'application/pdf',
    );
    expect(accountingAttachmentType({ contentType: '', fileName: 'invoice.pdf' })).toBe('application/pdf');
  });

  it('skips everything else', () => {
    expect(accountingAttachmentType({ contentType: 'application/octet-stream', fileName: 'data.bin' })).toBeNull();
    expect(accountingAttachmentType({ contentType: 'text/calendar', fileName: 'invite.ics' })).toBeNull();
    expect(
      accountingAttachmentType({
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileName: 'invoice.docx',
      }),
    ).toBeNull();
  });
});
