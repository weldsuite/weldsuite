
import React, { useState, useCallback } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Link } from '@/lib/router';
import { Star, Pin, Paperclip } from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@weldsuite/ui/components/context-menu';
import type { ConversationListItemProps } from './types';
import { getAvatarColor, getLabelColor, filterDisplayLabels } from './utils';

export function ConversationListItem({
  item,
  href,
  isSelected,
  isPinned,
  onClick,
  onToggleStar,
  contextMenuContent,
  onLabelDrop,
  compact,
}: ConversationListItemProps) {
  const t = useTranslations();
  const hasUnread = item.unreadCount > 0;
  const displayLabels = filterDisplayLabels(item.labels);
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!onLabelDrop) return;
    if (e.dataTransfer.types.includes('application/x-mail-label')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, [onLabelDrop]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!onLabelDrop) return;
    if (e.dataTransfer.types.includes('application/x-mail-label')) {
      e.preventDefault();
      setIsDragOver(true);
    }
  }, [onLabelDrop]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!onLabelDrop) return;
    // Only clear if leaving the item entirely (not entering a child)
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }, [onLabelDrop]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!onLabelDrop) return;
    e.preventDefault();
    setIsDragOver(false);
    const raw = e.dataTransfer.getData('application/x-mail-label');
    if (!raw) return;
    try {
      const labelData = JSON.parse(raw);
      onLabelDrop(labelData);
    } catch { /* ignore invalid data */ }
  }, [onLabelDrop]);

  const content = (
    <Link
      href={href}
      scroll={false}
      onClick={onClick ? (e) => { e.preventDefault(); onClick(); } : undefined}
      className={cn(
        'group border-b border-gray-100 dark:border-border transition-colors',
        // In compact mode the row may be stretched by FitContent; make it a
        // vertical flex so any extra height is split equally above and below
        // the content (otherwise top/bottom padding looks lopsided).
        compact ? 'flex flex-col justify-center' : 'block',
        isDragOver
          ? 'bg-blue-50 dark:bg-blue-950/30 ring-2 ring-inset ring-blue-400 dark:ring-blue-500'
          : isSelected ? 'bg-accent' : 'hover:bg-gray-50 dark:hover:bg-secondary'
      )}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className={cn('px-3 md:px-4', compact ? 'py-2' : 'py-3')}>
        <div className="flex items-start gap-2.5">
          {/* Avatar */}
          <div className="relative flex-shrink-0 mt-[3px]">
            {item.avatarUrl ? (
              <img
                src={item.avatarUrl}
                alt={item.name || ''}
                className="w-7 h-7 rounded-[10px] object-cover"
              />
            ) : (
              <div
                className="w-7 h-7 rounded-[10px] flex items-center justify-center text-white font-semibold text-xs"
                style={{ backgroundColor: getAvatarColor(item.name || '') }}
              >
                {(item.name || '?').charAt(0).toUpperCase()}
              </div>
            )}
            {hasUnread && !isSelected && (
              <div className="absolute top-1/2 -translate-y-1/2 -left-2.5 w-1.5 h-1.5 rounded-full bg-blue-600" />
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <span
                  className={cn(
                    'text-sm truncate',
                    hasUnread ? 'font-semibold text-gray-900 dark:text-foreground' : 'font-medium text-gray-500 dark:text-muted-foreground'
                  )}
                >
                  {item.name || t('sweep.shared.unknown')}
                </span>
                {item.messageCount > 1 && (
                  <span
                    className="h-[18px] min-w-[18px] flex items-center justify-center rounded-[6px] px-0.5 text-[10px] font-medium tabular-nums text-muted-foreground border border-gray-200 dark:border-border bg-gray-50 dark:bg-secondary/50 flex-shrink-0 select-none"
                    style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}
                  >
                    {item.messageCount}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {item.hasAttachments && (
                  <Paperclip className="h-3 w-3 text-gray-400 dark:text-muted-foreground" />
                )}
                {isPinned && <Pin className="h-3 w-3 text-blue-500 fill-blue-500" />}
                {item.isStarred && (
                  <Star className="h-3 w-3 text-yellow-500 fill-yellow-500 -translate-y-[1.5px]" />
                )}
                <span className="text-[11.5px] text-gray-400 dark:text-muted-foreground">
                  {format(new Date(item.date), 'h:mm a')}
                </span>
              </div>
            </div>
            <div
              className={cn(
                'text-sm truncate mt-px',
                hasUnread ? 'font-medium text-gray-800 dark:text-foreground' : 'text-gray-500 dark:text-muted-foreground'
              )}
            >
              {item.subject || t('sweep.shared.noSubject')}
            </div>
            <div className={cn('text-[13px] truncate mt-0.5', hasUnread ? 'text-gray-500 dark:text-muted-foreground' : 'text-gray-400 dark:text-muted-foreground')}>
              {item.preview}
            </div>
            {/* Label Badges */}
            {displayLabels.length > 0 && (
              <div className="flex gap-1 flex-wrap mt-2">
                {displayLabels.slice(0, 3).map((labelName) => {
                  const color = item.labelColors?.[labelName] ?? getLabelColor(labelName);
                  return (
                    <span
                      key={labelName}
                      className="px-2 py-0.5 rounded text-[12px] font-medium"
                      style={{
                        backgroundColor: `${color}15`,
                        color: color,
                      }}
                    >
                      {labelName}
                    </span>
                  );
                })}
                {displayLabels.length > 3 && (
                  <span className="text-[10px] text-gray-400 dark:text-muted-foreground">
                    +{displayLabels.length - 3}
                  </span>
                )}
              </div>
            )}
            {/* Unread count indicator */}
            {item.unreadCount > 0 && item.messageCount > 1 && (
              <div className="mt-1.5">
                <span className="text-[10px] text-blue-600 font-medium bg-blue-50 px-1.5 py-px rounded-full">
                  {t('sweep.shared.unreadCount', { count: item.unreadCount })}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </Link>
  );

  if (contextMenuContent) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {content}
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          {contextMenuContent}
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  return content;
}
