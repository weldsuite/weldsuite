import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  emailSizeExceedsLimit,
  MAX_EMAIL_SIZE_BYTES,
  MailAttachmentUploadError,
  uploadMailAttachments,
} from './upload-attachments';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('emailSizeExceedsLimit', () => {
  it('allows a small body with no attachments', () => {
    expect(emailSizeExceedsLimit('hi', '<p>hi</p>', [])).toBe(false);
  });

  it('rejects when attachments push the payload over the 5 MB cap', () => {
    const huge = new File([new Uint8Array(MAX_EMAIL_SIZE_BYTES)], 'huge.bin');
    expect(emailSizeExceedsLimit('x', 'x', [huge])).toBe(true);
  });
});

describe('uploadMailAttachments', () => {
  it('presigns each file, PUTs it, and returns fileKey descriptors', async () => {
    const client = {
      post: vi.fn().mockResolvedValue({
        uploadUrl: 'https://mock-upload.test/put',
        uploadToken: 'tok',
        fileKey: 'workspaces/test/note.txt',
      }),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );

    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
    const result = await uploadMailAttachments(client, 'acc_1', [file]);

    expect(client.post).toHaveBeenCalledWith('/storage/generate-upload-url', {
      fileName: 'note.txt',
      contentType: 'text/plain',
      fileSize: 5,
      folder: 'mail-attachments',
      entityType: 'mail-attachment',
      entityId: 'acc_1',
      isPublic: false,
    });
    expect(fetch).toHaveBeenCalledWith('https://mock-upload.test/put', {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(result).toEqual([
      {
        filename: 'note.txt',
        contentType: 'text/plain',
        size: 5,
        fileKey: 'workspaces/test/note.txt',
      },
    ]);
  });

  it('throws MailAttachmentUploadError with the failing filename', async () => {
    const client = {
      post: vi.fn().mockRejectedValue(new Error('nope')),
    };
    const file = new File(['x'], 'broken.pdf', { type: 'application/pdf' });

    await expect(uploadMailAttachments(client, 'acc_1', [file])).rejects.toEqual(
      expect.objectContaining({
        name: 'MailAttachmentUploadError',
        filename: 'broken.pdf',
      }),
    );
    expect(MailAttachmentUploadError).toBeDefined();
  });
});
