import { isToday, isYesterday, format } from 'date-fns';
import type { ConversationItem } from './types';

const AVATAR_COLORS = [
  '#4F46E5', '#7C3AED', '#EC4899', '#EF4444', '#F97316',
  '#EAB308', '#22C55E', '#14B8A6', '#06B6D4', '#3B82F6',
];

const LABEL_COLORS = [
  '#EF4444', '#F97316', '#F59E0B', '#EAB308', '#84CC16',
  '#22C55E', '#10B981', '#14B8A6', '#06B6D4', '#0EA5E9',
  '#3B82F6', '#6366F1', '#8B5CF6', '#A855F7', '#D946EF',
  '#EC4899', '#F43F5E',
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
}

export function getAvatarColor(name: string): string {
  return AVATAR_COLORS[hashString(name) % AVATAR_COLORS.length];
}

export function getLabelColor(labelName: string, colorMap?: Record<string, string>): string {
  const mapped = colorMap?.[labelName];
  if (mapped?.startsWith('#')) return mapped;
  return LABEL_COLORS[hashString(labelName) % LABEL_COLORS.length];
}

function getDateLabel(date: Date): string {
  if (isToday(date)) return 'Today';
  if (isYesterday(date)) return 'Yesterday';
  return format(date, 'MMMM d');
}

export function groupByDate<T extends { date: Date }>(items: T[]): Record<string, T[]> {
  const groups: Record<string, T[]> = {};

  items.forEach((item) => {
    const label = getDateLabel(new Date(item.date));
    if (!groups[label]) {
      groups[label] = [];
    }
    groups[label].push(item);
  });

  return groups;
}

export function formatParticipants(name: string, messageCount?: number): string {
  return name || 'Unknown';
}

// System labels are stored in UPPERCASE (INBOX, SENT, STARRED, TRASH, SPAM, ARCHIVE, DRAFTS, SNOOZED, SCHEDULED, MUTED)
// Only show custom (user-created) labels in the list UI
export function filterDisplayLabels(labels: string[]): string[] {
  return labels.filter((l) => l !== l.toUpperCase());
}
