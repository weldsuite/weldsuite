import { describe, expect, it } from 'vitest';
import { bareContentId, inboundAttachmentRecord } from './inbound-attachments';

describe('inboundAttachmentRecord (TASK-905)', () => {
  const content = new Uint8Array([1, 2, 3, 4]);

  it('stores the key and the Content-ID, never a public URL', () => {
    const { r2Key, contentType, row } = inboundAttachmentRecord(
      'org_ws',
      'mmsg_1',
      0,
      { fileName: 'logo (1).png', contentType: 'image/png', content, contentId: '<logo@acme>', disposition: 'inline' },
      'attach_1',
    );
    expect(r2Key).toBe('workspaces/org_ws/mail/attachments/mmsg_1/1_logo__1_.png');
    expect(contentType).toBe('image/png');
    expect(row).toEqual({
      id: 'attach_1',
      messageId: 'mmsg_1',
      fileName: 'logo (1).png',
      contentType: 'image/png',
      size: 4,
      storagePath: r2Key,
      isInline: true,
      contentId: 'logo@acme',
    });
    expect(row).not.toHaveProperty('downloadUrl');
    expect(JSON.stringify(row)).not.toMatch(/https?:/);
  });

  it('defaults the type and leaves contentId empty for a plain attachment', () => {
    const { row } = inboundAttachmentRecord('org_ws', 'mmsg_1', 2, { fileName: 'a.bin', content }, 'attach_2');
    expect(row.contentType).toBe('application/octet-stream');
    expect(row.storagePath).toBe('workspaces/org_ws/mail/attachments/mmsg_1/3_a.bin');
    expect(row.isInline).toBe(false);
    expect(row.contentId).toBeNull();
  });
});

describe('bareContentId', () => {
  it('strips the angle brackets and trims', () => {
    expect(bareContentId(' <image001.png@01D9> ')).toBe('image001.png@01D9');
    expect(bareContentId('plain')).toBe('plain');
    expect(bareContentId('<>')).toBeNull();
    expect(bareContentId(undefined)).toBeNull();
  });
});
