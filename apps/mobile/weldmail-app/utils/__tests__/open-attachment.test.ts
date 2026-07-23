/**
 * Tests for the attachment-open helper. `react-native` and `expo-web-browser`
 * are fully mocked so no native runtime loads under the node test env.
 */

const mockOpenBrowserAsync = jest.fn();
const mockOpenURL = jest.fn();
const mockAlert = jest.fn();

jest.mock('expo-web-browser', () => ({ openBrowserAsync: (...a: unknown[]) => mockOpenBrowserAsync(...a) }));
jest.mock('react-native', () => ({
  Alert: { alert: (...a: unknown[]) => mockAlert(...a) },
  Linking: { openURL: (...a: unknown[]) => mockOpenURL(...a) },
}));

import { openAttachment, resolveAttachmentUrl } from '../open-attachment';

beforeEach(() => {
  mockOpenBrowserAsync.mockReset().mockResolvedValue(undefined);
  mockOpenURL.mockReset().mockResolvedValue(undefined);
  mockAlert.mockReset();
});

describe('resolveAttachmentUrl', () => {
  it('returns the downloadUrl when it is a valid http(s) URL', () => {
    expect(resolveAttachmentUrl({ downloadUrl: 'https://cdn.x/a.pdf' })).toBe('https://cdn.x/a.pdf');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveAttachmentUrl({ downloadUrl: '  https://cdn.x/a.pdf  ' })).toBe('https://cdn.x/a.pdf');
  });

  it('falls back to url when downloadUrl is absent', () => {
    expect(resolveAttachmentUrl({ url: 'http://cdn.x/a.pdf' })).toBe('http://cdn.x/a.pdf');
  });

  it('returns null for empty, missing, or non-http URLs', () => {
    expect(resolveAttachmentUrl({ downloadUrl: '' })).toBeNull();
    expect(resolveAttachmentUrl({ downloadUrl: null })).toBeNull();
    expect(resolveAttachmentUrl({})).toBeNull();
    expect(resolveAttachmentUrl({ downloadUrl: 'file:///etc/passwd' })).toBeNull();
    expect(resolveAttachmentUrl({ downloadUrl: 'javascript:alert(1)' })).toBeNull();
  });
});

describe('openAttachment', () => {
  it('opens a valid attachment in the in-app browser', async () => {
    await openAttachment({ downloadUrl: 'https://cdn.x/a.pdf', fileName: 'a.pdf' });
    expect(mockOpenBrowserAsync).toHaveBeenCalledWith('https://cdn.x/a.pdf');
    expect(mockAlert).not.toHaveBeenCalled();
    expect(mockOpenURL).not.toHaveBeenCalled();
  });

  it('alerts (and does not open a browser) when there is no URL', async () => {
    await openAttachment({ downloadUrl: '', fileName: 'a.pdf' });
    expect(mockOpenBrowserAsync).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockAlert.mock.calls[0][1]).toContain('a.pdf');
  });

  it('falls back to Linking.openURL when the in-app browser throws', async () => {
    mockOpenBrowserAsync.mockRejectedValueOnce(new Error('no custom tabs'));
    await openAttachment({ downloadUrl: 'https://cdn.x/a.pdf' });
    expect(mockOpenURL).toHaveBeenCalledWith('https://cdn.x/a.pdf');
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('alerts when both the in-app browser and the OS handler fail', async () => {
    mockOpenBrowserAsync.mockRejectedValueOnce(new Error('no custom tabs'));
    mockOpenURL.mockRejectedValueOnce(new Error('no activity found'));
    await openAttachment({ downloadUrl: 'https://cdn.x/a.pdf', name: 'report.docx' });
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockAlert.mock.calls[0][1]).toContain('report.docx');
  });
});
