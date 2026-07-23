/**
 * Shared WeldSocial display metadata — status/platform labels, badge variants,
 * and lightweight date formatting used across the app's screens.
 */

import type { SocialPlatform, SocialPostStatus } from '@weldsuite/app-api-client/domains/social';

type BadgeVariant = 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline';

export const POST_STATUS_META: Record<SocialPostStatus, { label: string; variant: BadgeVariant }> = {
  draft: { label: 'Draft', variant: 'secondary' },
  pending_approval: { label: 'Pending approval', variant: 'warning' },
  approved: { label: 'Approved', variant: 'default' },
  scheduled: { label: 'Scheduled', variant: 'default' },
  publishing: { label: 'Publishing', variant: 'warning' },
  published: { label: 'Published', variant: 'success' },
  failed: { label: 'Failed', variant: 'destructive' },
  cancelled: { label: 'Cancelled', variant: 'outline' },
};

export const PLATFORM_META: Record<SocialPlatform, { label: string; color: string }> = {
  facebook: { label: 'Facebook', color: '#1877F2' },
  instagram: { label: 'Instagram', color: '#E4405F' },
  twitter: { label: 'X / Twitter', color: '#111111' },
  linkedin: { label: 'LinkedIn', color: '#0A66C2' },
  tiktok: { label: 'TikTok', color: '#69C9D0' },
};

export const APPROVAL_STATUS_META: Record<string, { label: string; variant: BadgeVariant }> = {
  pending: { label: 'Pending', variant: 'warning' },
  approved: { label: 'Approved', variant: 'success' },
  rejected: { label: 'Rejected', variant: 'destructive' },
  revision_requested: { label: 'Revision requested', variant: 'secondary' },
  withdrawn: { label: 'Withdrawn', variant: 'outline' },
  expired: { label: 'Expired', variant: 'outline' },
};

export const CAMPAIGN_STATUS_META: Record<string, { label: string; variant: BadgeVariant }> = {
  draft: { label: 'Draft', variant: 'secondary' },
  active: { label: 'Active', variant: 'success' },
  paused: { label: 'Paused', variant: 'warning' },
  completed: { label: 'Completed', variant: 'default' },
  archived: { label: 'Archived', variant: 'outline' },
};

export const ACCOUNT_STATUS_META: Record<string, { label: string; variant: BadgeVariant }> = {
  active: { label: 'Active', variant: 'success' },
  inactive: { label: 'Inactive', variant: 'outline' },
  expired: { label: 'Expired', variant: 'destructive' },
  error: { label: 'Error', variant: 'destructive' },
  pending_reauth: { label: 'Reconnect', variant: 'warning' },
};

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
