import type { ReactNode } from 'react';

export interface ConversationItem {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  subject: string;
  preview: string;
  date: Date;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  labels: string[];
  labelColors?: Record<string, string>;
  messageCount: number;
  unreadCount: number;
}

export interface ConversationListProps {
  items: ConversationItem[];
  selectedId?: string;
  getItemUrl: (item: ConversationItem) => string;
  onItemClick?: (item: ConversationItem) => void;
  filterContent?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  isPinned?: (id: string) => boolean;
  onTogglePin?: (id: string) => void;
  onToggleStar?: (id: string) => void;
  contextMenuItems?: (item: ConversationItem) => ReactNode;
  onLabelDrop?: (item: ConversationItem, labelData: { name: string; accountIds?: string[] }) => void;
  error?: string | null;
  currentPage?: number;
  totalPages?: number;
  totalCount?: number;
  pageSize?: number;
  getPageUrl?: (page: number) => string;
  emptyMessage?: string;
}

export interface ConversationListItemProps {
  item: ConversationItem;
  href: string;
  isSelected?: boolean;
  isPinned?: boolean;
  onClick?: () => void;
  onToggleStar?: () => void;
  contextMenuContent?: ReactNode;
  onLabelDrop?: (labelData: { name: string; accountIds?: string[] }) => void;
  /** Reduced vertical padding/spacing for tight surfaces (e.g. home widgets). */
  compact?: boolean;
}
