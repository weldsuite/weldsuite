import { describe, expect, it, vi } from 'vitest';
import { uploadErrorMessage } from './use-file-upload';

vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({}) }));

describe('uploadErrorMessage', () => {
  it("reads the upload route's own reason", () => {
    expect(uploadErrorMessage({ responseText: '{"error":"Storage is not configured"}' })).toBe('Storage is not configured');
    expect(uploadErrorMessage({ responseText: '{"error":{"code":"PAYLOAD_TOO_LARGE","message":"File is too large"}}' })).toBe('File is too large');
  });

  it('has none for a body that names no reason', () => {
    expect(uploadErrorMessage({ responseText: '<html>Bad gateway</html>' })).toBeUndefined();
    expect(uploadErrorMessage({ responseText: '' })).toBeUndefined();
    expect(uploadErrorMessage({ responseText: '{"error":""}' })).toBeUndefined();
  });
});
