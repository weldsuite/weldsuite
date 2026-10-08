import { describe, expect, it, vi } from 'vitest';
import {
  MAX_CHAT_UPLOAD_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
  fitAttachments,
  isChatUploadTooLarge,
  uploadChatFile,
} from './chat-upload';

describe('isChatUploadTooLarge', () => {
  it('allows a file at the limit and refuses one byte more', () => {
    expect(isChatUploadTooLarge({ size: MAX_CHAT_UPLOAD_BYTES })).toBe(false);
    expect(isChatUploadTooLarge({ size: MAX_CHAT_UPLOAD_BYTES + 1 })).toBe(true);
  });
});

describe('fitAttachments', () => {
  it('accepts files while the message has room', () => {
    expect(fitAttachments(['a', 'b'], 0)).toEqual({ accepted: ['a', 'b'], rejected: [] });
  });

  it('cuts off at the per-message limit, counting what is already attached', () => {
    const { accepted, rejected } = fitAttachments(['a', 'b', 'c'], MAX_MESSAGE_ATTACHMENTS - 2);
    expect(accepted).toEqual(['a', 'b']);
    expect(rejected).toEqual(['c']);
  });

  it('accepts nothing on a full message', () => {
    expect(fitAttachments(['a'], MAX_MESSAGE_ATTACHMENTS + 3)).toEqual({ accepted: [], rejected: ['a'] });
  });
});

describe('uploadChatFile', () => {
  it('posts the file and channel to the chat-api upload route', async () => {
    const postForm = vi.fn().mockResolvedValue({
      data: { id: 'chatfile_1', fileName: 'a.txt', fileSize: 3, mimeType: 'text/plain', url: 'https://cdn/x/a.txt' },
    });
    const file = new File(['abc'], 'a.txt', { type: 'text/plain' });

    const uploaded = await uploadChatFile({ postForm }, file, 'ch_1');

    expect(uploaded.url).toBe('https://cdn/x/a.txt');
    const [path, form] = postForm.mock.calls[0] as [string, FormData];
    expect(path).toBe('/chat-messages/upload');
    expect(form.get('channelId')).toBe('ch_1');
    expect((form.get('file') as File).name).toBe('a.txt');
  });

  it('fails when the response carries no file', async () => {
    const postForm = vi.fn().mockResolvedValue({ data: null });
    await expect(uploadChatFile({ postForm }, new File(['x'], 'x.txt'))).rejects.toThrow();
  });
});
