const LABEL_COLORS = [
  '#EF4444', '#F97316', '#F59E0B', '#EAB308', '#84CC16',
  '#22C55E', '#10B981', '#14B8A6', '#06B6D4', '#0EA5E9',
  '#3B82F6', '#6366F1', '#8B5CF6', '#A855F7', '#D946EF',
  '#EC4899', '#F43F5E',
];

const SYSTEM_LABEL_SLUGS = new Set([
  'INBOX', 'STARRED', 'SENT', 'DRAFTS', 'TRASH', 'SPAM', 'ARCHIVE',
  'SCHEDULED', 'SNOOZED', 'IMPORTANT', 'ALL', 'MUTED', 'UNREAD',
  'DRAFT',
]);

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
}

export function getLabelColor(labelName: string, colorMap?: Record<string, string>): string {
  const mapped = colorMap?.[labelName];
  if (mapped?.startsWith('#')) return mapped;
  return LABEL_COLORS[hashString(labelName) % LABEL_COLORS.length];
}

export function filterDisplayLabels(labels: string[]): string[] {
  return labels.filter((l) => l !== l.toUpperCase());
}

export function isSystemLabel(slug: string): boolean {
  return SYSTEM_LABEL_SLUGS.has(slug.toUpperCase());
}
