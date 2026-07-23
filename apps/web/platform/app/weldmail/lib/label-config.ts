/**
 * Label Configuration
 *
 * Defines system labels (Inbox, Starred, Sent, etc.) and provides utilities
 * for unified label-based routing. Both system and user labels use the same
 * route structure: /mail/[accountId]/[labelSlug]
 */

export type SystemLabelSlug =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'starred'
  | 'important'
  | 'all'
  | 'archive'
  | 'spam'
  | 'trash'
  | 'scheduled'
  | 'snoozed';

export type FilterType = 'label' | 'virtual';

export interface SystemLabelConfig {
  slug: SystemLabelSlug;
  /** The UPPERCASE label stored in the JSONB labels array */
  systemLabel: string;
  displayName: string;
  icon: string;
  filterType: FilterType;
  /** Whether this label appears in the main mailbox list */
  isMainMailbox: boolean;
  /** Whether this label appears in the "More" section */
  isSecondary: boolean;
}

export const SYSTEM_LABELS: Record<SystemLabelSlug, SystemLabelConfig> = {
  inbox: {
    slug: 'inbox',
    systemLabel: 'INBOX',
    displayName: 'Inbox',
    icon: 'Inbox',
    filterType: 'label',
    isMainMailbox: true,
    isSecondary: false,
  },
  starred: {
    slug: 'starred',
    systemLabel: 'STARRED',
    displayName: 'Starred',
    icon: 'Star',
    filterType: 'label',
    isMainMailbox: true,
    isSecondary: false,
  },
  sent: {
    slug: 'sent',
    systemLabel: 'SENT',
    displayName: 'Sent',
    icon: 'Send',
    filterType: 'label',
    isMainMailbox: true,
    isSecondary: false,
  },
  drafts: {
    slug: 'drafts',
    systemLabel: 'DRAFTS',
    displayName: 'Drafts',
    icon: 'FileText',
    filterType: 'label',
    isMainMailbox: true,
    isSecondary: false,
  },
  scheduled: {
    slug: 'scheduled',
    systemLabel: 'SCHEDULED',
    displayName: 'Scheduled',
    icon: 'Clock',
    filterType: 'label',
    isMainMailbox: false,
    isSecondary: true,
  },
  snoozed: {
    slug: 'snoozed',
    systemLabel: 'SNOOZED',
    displayName: 'Snoozed',
    icon: 'Clock',
    filterType: 'label',
    isMainMailbox: false,
    isSecondary: true,
  },
  important: {
    slug: 'important',
    systemLabel: 'IMPORTANT',
    displayName: 'Important',
    icon: 'AlertCircle',
    filterType: 'label',
    isMainMailbox: false,
    isSecondary: true,
  },
  all: {
    slug: 'all',
    systemLabel: 'ALL',
    displayName: 'All Mail',
    icon: 'Mail',
    filterType: 'virtual',
    isMainMailbox: false,
    isSecondary: true,
  },
  archive: {
    slug: 'archive',
    systemLabel: 'ARCHIVE',
    displayName: 'Archive',
    icon: 'Archive',
    filterType: 'label',
    isMainMailbox: false,
    isSecondary: true,
  },
  spam: {
    slug: 'spam',
    systemLabel: 'SPAM',
    displayName: 'Spam',
    icon: 'AlertCircle',
    filterType: 'label',
    isMainMailbox: false,
    isSecondary: true,
  },
  trash: {
    slug: 'trash',
    systemLabel: 'TRASH',
    displayName: 'Trash',
    icon: 'Trash2',
    filterType: 'label',
    isMainMailbox: false,
    isSecondary: true,
  },
};

/**
 * Check if a slug is a system label
 */
export function isSystemLabel(slug: string): slug is SystemLabelSlug {
  return slug in SYSTEM_LABELS;
}

/**
 * Get system label configuration by slug
 */
export function getSystemLabelConfig(slug: string): SystemLabelConfig | null {
  if (isSystemLabel(slug)) {
    return SYSTEM_LABELS[slug];
  }
  return null;
}

/**
 * Get main mailbox labels (shown by default in sidebar)
 */
export function getMainMailboxLabels(): SystemLabelConfig[] {
  return Object.values(SYSTEM_LABELS).filter((l) => l.isMainMailbox);
}

/**
 * Get secondary labels (shown in "More" section)
 */
export function getSecondaryLabels(): SystemLabelConfig[] {
  return Object.values(SYSTEM_LABELS).filter((l) => l.isSecondary);
}

/**
 * Get display name for a label slug (system or user label)
 */
export function getLabelDisplayName(slug: string): string {
  const config = getSystemLabelConfig(slug);
  if (config) {
    return config.displayName;
  }
  // For user labels, return the slug with first letter capitalized
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}
