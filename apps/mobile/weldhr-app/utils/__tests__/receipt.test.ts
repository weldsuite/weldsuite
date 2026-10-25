jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('@/services/app-api', () => ({ appApiClient: { postForm: jest.fn(() => Promise.resolve({})) } }));

import { appApiClient } from '@/services/app-api';
import { toReceipt, uploadReceipt } from '../receipt';

const NOW = new Date('2026-10-24T10:00:00Z');

describe('toReceipt', () => {
  it('keeps a photo the API accepts and names it when the picker did not', () => {
    expect(toReceipt({ uri: 'file:///tmp/IMG_1.jpg', mimeType: 'image/jpeg', fileSize: 2_000_000 }, NOW)).toEqual({
      uri: 'file:///tmp/IMG_1.jpg',
      name: 'receipt-2026-10-24.jpg',
      type: 'image/jpeg',
      size: 2_000_000,
    });
  });

  it('guesses the type from the file name', () => {
    const receipt = toReceipt({ uri: 'file:///tmp/scan.PDF', fileName: 'scan.PDF' }, NOW);
    expect(receipt).toMatchObject({ type: 'application/pdf', name: 'scan.PDF' });
  });

  it('refuses types and sizes hr-api would reject', () => {
    expect(toReceipt({ uri: 'file:///tmp/a.heic', mimeType: 'image/heic' }, NOW)).toBe('type');
    expect(toReceipt({ uri: 'file:///tmp/a.png', mimeType: 'image/png', fileSize: 11 * 1024 * 1024 }, NOW)).toBe('size');
  });
});

describe('uploadReceipt', () => {
  it('posts the file to the caller\'s own declaration as multipart `file`', async () => {
    await uploadReceipt('dcl 1', { uri: 'file:///tmp/a.jpg', name: 'a.jpg', type: 'image/jpeg' });
    const [path, form] = (appApiClient.postForm as jest.Mock).mock.calls[0];
    expect(path).toBe('/weldhr/me/declarations/dcl%201/receipt');
    expect((form as FormData).get('file')).toBeTruthy();
  });
});
