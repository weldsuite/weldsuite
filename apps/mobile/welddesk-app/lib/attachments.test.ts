/**
 * Unit tests for attachment helpers.
 * Run via: pnpm --filter platform exec vitest run ../../mobile/welddesk-app/lib/attachments.test.ts
 * (same convention as hooks/inbox-realtime-dispatch.test.ts; files are React-free).
 */
import { describe, expect, it } from 'vitest';
import { formatFileSize, isImageAttachment, isOpenableUrl } from './attachments';

describe('formatFileSize', () => {
  it('formats bytes, KB, MB and GB', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(1024 * 1024 * 2)).toBe('2 MB');
    expect(formatFileSize(1024 * 1024 * 25)).toBe('25 MB');
    expect(formatFileSize(1024 ** 3 * 3)).toBe('3 GB');
  });

  it('returns an empty string for unknown sizes', () => {
    expect(formatFileSize(0)).toBe('');
    expect(formatFileSize(undefined)).toBe('');
    expect(formatFileSize(Number.NaN)).toBe('');
  });
});

describe('isImageAttachment', () => {
  it('matches image content types case-insensitively', () => {
    expect(isImageAttachment({ contentType: 'image/png' })).toBe(true);
    expect(isImageAttachment({ contentType: 'IMAGE/JPEG' })).toBe(true);
    expect(isImageAttachment({ contentType: 'application/pdf' })).toBe(false);
  });
});

describe('isOpenableUrl', () => {
  it('only allows http(s)', () => {
    expect(isOpenableUrl('https://cdn.example.com/a.png')).toBe(true);
    expect(isOpenableUrl('http://cdn.example.com/a.png')).toBe(true);
    expect(isOpenableUrl('javascript:alert(1)')).toBe(false);
    expect(isOpenableUrl('')).toBe(false);
    expect(isOpenableUrl(null)).toBe(false);
  });
});
