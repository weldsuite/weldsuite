/** Pure helpers for rendering desk message attachments. React-free so they are unit-testable. */

import type { DeskMessageAttachment } from '@/types/desk';

const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/** Human readable file size, e.g. `1.4 MB`. Returns an empty string for unknown sizes. */
export function formatFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${UNITS[unit]}`;
}

export function isImageAttachment(attachment: Pick<DeskMessageAttachment, 'contentType'>): boolean {
  return (attachment.contentType ?? '').toLowerCase().startsWith('image/');
}

/** Only http(s) URLs are opened from a thread; anything else (javascript:, file:) is ignored. */
export function isOpenableUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim());
}
