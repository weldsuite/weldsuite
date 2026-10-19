/**
 * Tests for the attachment-open helper. `react-native`, `expo-file-system` and
 * the app-api service are fully mocked so no native runtime loads under the
 * node test env.
 */

import { openAttachment, resolveAttachmentId, safeCacheFileName } from '../open-attachment';

const mockAlert = jest.fn();
const mockOpenURL = jest.fn();
const mockShare = jest.fn();
const mockRequestInit = jest.fn();
const mockDownload = jest.fn();
const mockDirCreate = jest.fn();
let mockPlatform = 'ios';

jest.mock('react-native', () => ({
  Alert: { alert: (...a: unknown[]) => mockAlert(...a) },
  Linking: { openURL: (...a: unknown[]) => mockOpenURL(...a) },
  Share: { share: (...a: unknown[]) => mockShare(...a) },
  Platform: {
    get OS() {
      return mockPlatform;
    },
  },
}));

jest.mock('@/services/app-api', () => ({
  getAppApiRequestInit: (...a: unknown[]) => mockRequestInit(...a),
}));

jest.mock('expo-file-system', () => {
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
    }
    create(...a: unknown[]) {
      mockDirCreate(...a);
    }
  }
  class File {
    uri: string;
    contentUri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
      this.contentUri = this.uri.replace('file://', 'content://');
    }
    static downloadFileAsync(...a: unknown[]) {
      return mockDownload(...a);
    }
  }
  return { Directory, File, Paths: { cache: { uri: 'file://cache' } } };
});

const URL = 'https://mail-api.weldsuite.org/api/mail-attachments/att_1/download';
const HEADERS = { Authorization: 'Bearer jwt', 'X-Weld-App': 'weldmail' };

beforeEach(() => {
  mockPlatform = 'ios';
  mockAlert.mockReset();
  mockOpenURL.mockReset().mockResolvedValue(undefined);
  mockShare.mockReset().mockResolvedValue({ action: 'sharedAction' });
  mockDirCreate.mockReset();
  mockRequestInit.mockReset().mockResolvedValue({ url: URL, headers: HEADERS });
  mockDownload
    .mockReset()
    .mockImplementation(async (_url: string, file: { uri: string; contentUri: string }) => file);
});

describe('resolveAttachmentId', () => {
  it('returns the trimmed id', () => {
    expect(resolveAttachmentId({ id: ' att_1 ' })).toBe('att_1');
  });

  it('returns null for missing or blank ids', () => {
    expect(resolveAttachmentId({})).toBeNull();
    expect(resolveAttachmentId({ id: '' })).toBeNull();
    expect(resolveAttachmentId({ id: '   ' })).toBeNull();
    expect(resolveAttachmentId({ id: null })).toBeNull();
  });
});

describe('safeCacheFileName', () => {
  it('keeps ordinary names', () => {
    expect(safeCacheFileName('Invoice March.pdf')).toBe('Invoice March.pdf');
  });

  it('strips path separators and leading dots', () => {
    expect(safeCacheFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeCacheFileName('a/b\\c.txt')).toBe('a_b_c.txt');
    expect(safeCacheFileName('..hidden')).toBe('hidden');
  });

  it('falls back when nothing is left', () => {
    expect(safeCacheFileName('')).toBe('attachment');
    expect(safeCacheFileName('...')).toBe('attachment');
  });
});

describe('openAttachment', () => {
  it('downloads through the authenticated endpoint into the cache, named after the file, then shares it on iOS', async () => {
    await openAttachment({ id: 'att_1', fileName: 'a.pdf' });

    expect(mockRequestInit).toHaveBeenCalledWith('/mail-attachments/att_1/download');
    expect(mockDirCreate).toHaveBeenCalledWith({ intermediates: true, idempotent: true });
    expect(mockDownload).toHaveBeenCalledTimes(1);
    const [url, file, options] = mockDownload.mock.calls[0];
    expect(url).toBe(URL);
    expect(file.uri).toBe('file://cache/mail-attachments/att_1/a.pdf');
    expect(options).toEqual({ headers: HEADERS, idempotent: true });
    expect(mockShare).toHaveBeenCalledWith({ url: 'file://cache/mail-attachments/att_1/a.pdf' });
    expect(mockOpenURL).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('opens the content URI with the OS handler on Android', async () => {
    mockPlatform = 'android';
    await openAttachment({ id: 'att_1', filename: 'a.pdf' });
    expect(mockOpenURL).toHaveBeenCalledWith('content://cache/mail-attachments/att_1/a.pdf');
    expect(mockShare).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('uses a sanitised file name for the cache file', async () => {
    await openAttachment({ id: 'att_1', fileName: '../evil/name.pdf' });
    const file = mockDownload.mock.calls[0][1];
    expect(file.uri).toBe('file://cache/mail-attachments/att_1/_evil_name.pdf');
  });

  it('alerts (and never calls the network) when the attachment has no id', async () => {
    await openAttachment({ fileName: 'a.pdf' });
    expect(mockRequestInit).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockAlert.mock.calls[0][1]).toContain('a.pdf');
  });

  it('never falls back to a public URL carried on the attachment', async () => {
    await openAttachment({ fileName: 'a.pdf', downloadUrl: 'https://cdn.x/a.pdf' } as never);
    expect(mockOpenURL).not.toHaveBeenCalled();
    expect(mockShare).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledTimes(1);
  });

  it('alerts when there is no session', async () => {
    mockRequestInit.mockRejectedValueOnce(new Error('Authentication required'));
    await openAttachment({ id: 'att_1', fileName: 'a.pdf' });
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockAlert.mock.calls[0][1]).toContain('a.pdf');
  });

  it('says the attachment is unavailable when the endpoint answers 404', async () => {
    mockDownload.mockRejectedValueOnce(new Error('Unable to download file: HTTP status 404'));
    await openAttachment({ id: 'att_1', fileName: 'a.pdf' });
    expect(mockShare).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockAlert.mock.calls[0][1]).toContain("isn't available");
  });

  it('asks to retry when the download fails for another reason', async () => {
    mockDownload.mockRejectedValueOnce(new Error('Network request failed'));
    await openAttachment({ id: 'att_1', name: 'report.docx' });
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockAlert.mock.calls[0][1]).toContain('report.docx');
    expect(mockAlert.mock.calls[0][1]).toContain('try again');
  });

  it('alerts when the OS cannot open the downloaded file', async () => {
    mockPlatform = 'android';
    mockOpenURL.mockRejectedValueOnce(new Error('no activity found'));
    await openAttachment({ id: 'att_1', name: 'report.docx' });
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockAlert.mock.calls[0][1]).toContain('report.docx');
  });
});
