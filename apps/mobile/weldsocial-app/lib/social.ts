/**
 * Shared WeldSocial display metadata — platform labels, status badge variants
 * and lightweight date formatting used across the app's screens. Status labels
 * are translated and live in the i18n catalog (`lib/i18n`).
 */

import type { SocialPlatform, SocialPostStatus } from '@weldsuite/app-api-client/domains/social';

export type BadgeVariant = 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline';

export const POST_STATUS_VARIANT: Record<SocialPostStatus, BadgeVariant> = {
  draft: 'secondary',
  pending_approval: 'warning',
  approved: 'default',
  scheduled: 'default',
  publishing: 'warning',
  published: 'success',
  failed: 'destructive',
  cancelled: 'outline',
};

export const PLATFORM_META: Record<SocialPlatform, { label: string; color: string }> = {
  facebook: { label: 'Facebook', color: '#1877F2' },
  instagram: { label: 'Instagram', color: '#E4405F' },
  twitter: { label: 'X / Twitter', color: '#111111' },
  linkedin: { label: 'LinkedIn', color: '#0A66C2' },
  tiktok: { label: 'TikTok', color: '#69C9D0' },
};

export const APPROVAL_STATUS_VARIANT: Record<string, BadgeVariant> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'destructive',
  revision_requested: 'secondary',
  withdrawn: 'outline',
  expired: 'outline',
};

export const CAMPAIGN_STATUS_VARIANT: Record<string, BadgeVariant> = {
  draft: 'secondary',
  active: 'success',
  paused: 'warning',
  completed: 'default',
  archived: 'outline',
};

export const ACCOUNT_STATUS_VARIANT: Record<string, BadgeVariant> = {
  active: 'success',
  inactive: 'outline',
  expired: 'destructive',
  error: 'destructive',
  pending_reauth: 'warning',
};

/**
 * Badge label + variant for a status. Labels come from the i18n catalog;
 * an unknown status (newer server) falls back to its readable raw value.
 */
export function statusBadge(
  variants: Record<string, BadgeVariant>,
  labels: Record<string, string>,
  status: string,
): { label: string; variant: BadgeVariant } {
  return {
    label: labels[status] ?? status.replaceAll('_', ' '),
    variant: variants[status] ?? 'outline',
  };
}

/** "Mon 6 Jul, 14:30" style short date-time in the device locale. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "14:30" in the device locale. */
export function formatTime(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Local-timezone YYYY-MM-DD key for calendar bucketing. */
export function toDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Compact number: 12500 → "12.5K". */
export function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}
