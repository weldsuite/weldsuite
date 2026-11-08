import type { SoftTone } from '@weldsuite/ui/components/soft-badge';
import type { DeskAnnouncement } from '@/hooks/queries/use-desk-knowledge-queries';

/** The banner colour of each type, as a badge tone. */
export const ANNOUNCEMENT_TYPE_TONE: Record<string, SoftTone> = {
  info: 'neutral',
  warning: 'warning',
  success: 'success',
  error: 'danger',
};

export const ANNOUNCEMENT_STATUS_TONE: Record<string, SoftTone> = {
  draft: 'neutral',
  published: 'success',
  archived: 'neutral',
};

/** Whether a published announcement's end has passed. */
export function isExpired(announcement: Pick<DeskAnnouncement, 'expiresAt'>, now = Date.now()): boolean {
  if (!announcement.expiresAt) return false;
  const end = Date.parse(announcement.expiresAt);
  return !Number.isNaN(end) && end <= now;
}

/** `2026-03-01T09:30:00.000Z` → the `yyyy-MM-ddTHH:mm` a `datetime-local` input shows, in local time. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A `datetime-local` value (local time) → an ISO instant with `Z`; null when empty or invalid. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
