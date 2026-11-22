import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ download: vi.fn() }));

vi.mock('./api-client', () => ({ mailApi: { attachments: { download: mocks.download } } }));

const { MailAttachmentDownloadError, fetchMailAttachment, saveMailAttachment } = await import('./download-attachment');

beforeEach(() => {
  mocks.download.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchMailAttachment', () => {
  it('returns the file', async () => {
    const blob = new Blob(['hello']);
    mocks.download.mockResolvedValue({ success: true, data: blob });
    await expect(fetchMailAttachment('attach_1')).resolves.toBe(blob);
    expect(mocks.download).toHaveBeenCalledWith('attach_1');
  });

  it('carries the server error code of a refused download', async () => {
    mocks.download.mockResolvedValue({
      success: false,
      error: 'This attachment contains a virus',
      errorCode: 'ATTACHMENT_INFECTED',
    });
    const error = await fetchMailAttachment('attach_1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailAttachmentDownloadError);
    expect(error).toMatchObject({ message: 'This attachment contains a virus', code: 'ATTACHMENT_INFECTED' });
  });

  it('falls back to a plain message without one', async () => {
    mocks.download.mockResolvedValue({ success: false });
    await expect(fetchMailAttachment('attach_1')).rejects.toMatchObject({ message: 'Download failed', code: undefined });
  });
});

describe('saveMailAttachment', () => {
  it('hands the file to the browser under its name', async () => {
    mocks.download.mockResolvedValue({ success: true, data: new Blob(['hello']) });
    const createObjectURL = vi.fn(() => 'blob:attach_1');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      await saveMailAttachment('attach_1', 'report.pdf');
      expect(click).toHaveBeenCalledOnce();
      const anchor = click.mock.contexts[0] as HTMLAnchorElement;
      expect(anchor.download).toBe('report.pdf');
      expect(anchor.href).toBe('blob:attach_1');
      expect(document.querySelector('a[download]')).toBeNull();
      vi.advanceTimersByTime(10_000);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:attach_1');
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
