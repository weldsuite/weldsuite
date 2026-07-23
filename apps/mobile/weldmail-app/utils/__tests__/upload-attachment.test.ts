import { uploadMailAttachment, uploadMailAttachments } from '../upload-attachment';
import { appApiClient } from '@/services/app-api';

// Replace the real client so we can assert on the storage broker call.
jest.mock('@/services/app-api', () => ({ appApiClient: { post: jest.fn() } }));

const mockedPost = appApiClient.post as jest.Mock;
const att = { name: 'report.pdf', uri: 'file:///report.pdf', type: 'application/pdf' };

describe('uploadMailAttachment', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    mockedPost.mockReset();
    fetchMock = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  });

  it('reads the file, requests an upload URL, PUTs the bytes, and returns the send descriptor', async () => {
    const blob = { size: 1234, type: 'application/pdf' };
    fetchMock
      .mockResolvedValueOnce({ ok: true, blob: async () => blob }) // read local file
      .mockResolvedValueOnce({ ok: true }); // PUT bytes
    mockedPost.mockResolvedValueOnce({
      success: true,
      uploadUrl: 'https://app-api.test/api/storage/upload/tok',
      uploadToken: 'tok',
      fileKey: 'workspaces/w1/mail-attachments/general/report.pdf',
    });

    const result = await uploadMailAttachment(att);

    expect(mockedPost).toHaveBeenCalledWith(
      '/storage/generate-upload-url',
      expect.objectContaining({
        fileName: 'report.pdf',
        contentType: 'application/pdf',
        fileSize: 1234,
        folder: 'mail-attachments',
      }),
    );
    // Bytes are PUT (not POSTed as JSON) to the presigned URL.
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://app-api.test/api/storage/upload/tok',
      expect.objectContaining({ method: 'PUT', body: blob }),
    );
    expect(result).toEqual({
      filename: 'report.pdf',
      contentType: 'application/pdf',
      size: 1234,
      fileKey: 'workspaces/w1/mail-attachments/general/report.pdf',
    });
  });

  it('throws (and does not request an upload URL) if the local file cannot be read', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });
    await expect(uploadMailAttachment(att)).rejects.toThrow(/Could not read/);
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('throws if the byte upload fails — never silently resolves', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, blob: async () => ({ size: 10, type: 'application/pdf' }) })
      .mockResolvedValueOnce({ ok: false, status: 500 });
    mockedPost.mockResolvedValueOnce({
      success: true,
      uploadUrl: 'https://app-api.test/api/storage/upload/tok',
      uploadToken: 'tok',
      fileKey: 'k',
    });
    await expect(uploadMailAttachment(att)).rejects.toThrow(/Upload failed/);
  });

  it('falls back to octet-stream when the picked type is empty', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, blob: async () => ({ size: 1, type: '' }) })
      .mockResolvedValueOnce({ ok: true });
    mockedPost.mockResolvedValueOnce({ success: true, uploadUrl: 'https://x/u', uploadToken: 't', fileKey: 'k' });
    const result = await uploadMailAttachment({ name: 'x.bin', uri: 'file:///x.bin', type: '' });
    expect(result.contentType).toBe('application/octet-stream');
  });
});

describe('uploadMailAttachments', () => {
  it('resolves a descriptor for every attachment', async () => {
    const fetchMock = jest.fn(async (url: unknown) =>
      typeof url === 'string' && url.startsWith('file://')
        ? { ok: true, blob: async () => ({ size: 5, type: 'text/plain' }) }
        : { ok: true },
    );
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    mockedPost.mockReset();
    mockedPost.mockResolvedValue({ success: true, uploadUrl: 'https://x/u', uploadToken: 't', fileKey: 'k' });

    const out = await uploadMailAttachments([att, { name: 'b.txt', uri: 'file:///b.txt', type: 'text/plain' }]);
    expect(out).toHaveLength(2);
    expect(out.every((d) => d.fileKey === 'k')).toBe(true);
  });
});
