
import React, { useState, useRef, useEffect } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Link } from '@/lib/router';
import { Search, AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import type { ConversationListProps, ConversationItem } from './types';
import { groupByDate } from './utils';
import { ConversationListItem } from './conversation-list-item';

export function ConversationList({
  items,
  selectedId,
  getItemUrl,
  onItemClick,
  filterContent,
  actionLabel,
  onAction,
  isPinned,
  onTogglePin,
  onToggleStar,
  contextMenuItems,
  onLabelDrop,
  error,
  currentPage = 1,
  totalPages = 1,
  totalCount = 0,
  pageSize = 25,
  getPageUrl,
  emptyMessage,
}: ConversationListProps) {
  const t = useTranslations();
  const resolvedEmptyMessage = emptyMessage ?? t('sweep.shared.noConversationsFound');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // Filter items by search
  const filteredItems = items.filter((item) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      item.name?.toLowerCase().includes(query) ||
      item.email?.toLowerCase().includes(query) ||
      item.subject?.toLowerCase().includes(query) ||
      item.preview?.toLowerCase().includes(query)
    );
  });

  // Sort: pinned first
  const sortedItems = isPinned
    ? [...filteredItems].sort((a, b) => {
        const aP = isPinned(a.id) ? 1 : 0;
        const bP = isPinned(b.id) ? 1 : 0;
        return bP - aP;
      })
    : filteredItems;

  const grouped = groupByDate(sortedItems);
  const isEmpty = sortedItems.length === 0;

  return (
    <div className="bg-white dark:bg-background flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 h-[53px] border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          {filterContent}
        </div>

        <div className="flex-1 flex items-center justify-end gap-2">
          {/* Search */}
          <div
            className="flex items-center overflow-hidden transition-[width] duration-200 ease-out"
            style={{ width: searchOpen ? 'calc(100% - 96px)' : '32px' }}
          >
            {!searchOpen ? (
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0 flex-shrink-0 shadow-none"
                onClick={() => setSearchOpen(true)}
              >
                <Search className="h-4 w-4" />
              </Button>
            ) : (
              <div className="relative w-full">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder={t('sweep.shared.searchPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onBlur={() => !searchQuery && setSearchOpen(false)}
                  className="h-8 w-full pl-8 pr-3 text-sm border border-border rounded-md bg-background focus:outline-none"
                />
              </div>
            )}
          </div>

          {/* Action Button */}
          {actionLabel && onAction && (
            <Button
              size="sm"
              className="h-8 bg-primary text-primary-foreground hover:bg-primary/90 flex-shrink-0"
              onClick={onAction}
            >
              {actionLabel}
            </Button>
          )}
        </div>
      </div>

      {/* List */}
      <div
        className="flex-1 overflow-y-auto px-1 md:px-0"
      >
        {error ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mb-3">
              <AlertTriangle className="h-5 w-5 text-red-500" />
            </div>
            <p className="text-sm font-medium text-red-600 mb-1">{t('sweep.shared.failedToLoadMessages')}</p>
            <p className="text-xs text-gray-500 dark:text-muted-foreground max-w-xs text-center">{error}</p>
          </div>
        ) : isEmpty ? (
          <div className="flex flex-col items-center justify-center py-20">
            <p className="text-sm text-gray-500 dark:text-muted-foreground">{resolvedEmptyMessage}</p>
          </div>
        ) : (
          <div>
            {Object.entries(grouped).map(([dateLabel, group]) => (
              <div key={dateLabel}>
                {dateLabel !== 'Today' && (
                  <div className="relative -mt-px flex items-center gap-2 px-3 md:px-4 h-8 bg-background border-t border-b border-border/70">
                    <div className="absolute inset-0 bg-muted/50 pointer-events-none" />
                    <span className="relative text-xs font-medium text-muted-foreground">{dateLabel}</span>
                    <span className="relative text-[10px] font-mono text-muted-foreground bg-muted border border-border w-[16px] h-[16px] flex items-center justify-center rounded-[5px] -translate-y-px">
                      <span className="translate-y-[1px]">{group.length}</span>
                    </span>
                  </div>
                )}
                {group.map((item) => (
                  <ConversationListItem
                    key={item.id}
                    item={item}
                    href={getItemUrl(item)}
                    isSelected={selectedId === item.id}
                    isPinned={isPinned?.(item.id)}
                    onClick={onItemClick ? () => onItemClick(item) : undefined}
                    onToggleStar={onToggleStar ? () => onToggleStar(item.id) : undefined}
                    contextMenuContent={contextMenuItems?.(item)}
                    onLabelDrop={onLabelDrop ? (labelData) => onLabelDrop(item, labelData) : undefined}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pagination Controls */}
      {totalPages > 1 && getPageUrl && (
        <div className="flex-shrink-0 border-t border-gray-200 dark:border-border px-3 md:px-4 py-2.5 md:py-3 bg-white dark:bg-background">
          <div className="flex items-center justify-between">
            <div className="text-xs text-gray-500 dark:text-muted-foreground">
              <span className="hidden md:inline">
                {t('sweep.shared.paginationRangeOfTotal', {
                  from: ((currentPage - 1) * pageSize) + 1,
                  to: Math.min(currentPage * pageSize, totalCount),
                  total: totalCount,
                })}
              </span>
              <span className="md:hidden">{currentPage}/{totalPages}</span>
            </div>
            <div className="flex items-center gap-1">
              {currentPage > 1 ? (
                <Link
                  href={getPageUrl(currentPage - 1)}
                  className="h-8 w-8 p-0 inline-flex items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Link>
              ) : (
                <span className="h-8 w-8 p-0 inline-flex items-center justify-center rounded-md opacity-50 cursor-not-allowed">
                  <ChevronLeft className="h-4 w-4" />
                </span>
              )}
              <div className="hidden md:flex items-center gap-1 px-2">
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let pageNum: number;
                  if (totalPages <= 5) {
                    pageNum = i + 1;
                  } else if (currentPage <= 3) {
                    pageNum = i + 1;
                  } else if (currentPage >= totalPages - 2) {
                    pageNum = totalPages - 4 + i;
                  } else {
                    pageNum = currentPage - 2 + i;
                  }
                  return (
                    <Link
                      key={pageNum}
                      href={getPageUrl(pageNum)}
                      className={cn(
                        'h-8 min-w-8 px-2 text-sm rounded-md transition-colors inline-flex items-center justify-center',
                        pageNum === currentPage
                          ? 'bg-blue-600 text-white'
                          : 'hover:bg-gray-100 dark:hover:bg-secondary text-gray-600 dark:text-muted-foreground'
                      )}
                    >
                      {pageNum}
                    </Link>
                  );
                })}
              </div>
              {currentPage < totalPages ? (
                <Link
                  href={getPageUrl(currentPage + 1)}
                  className="h-8 w-8 p-0 inline-flex items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
                >
                  <ChevronRight className="h-4 w-4" />
                </Link>
              ) : (
                <span className="h-8 w-8 p-0 inline-flex items-center justify-center rounded-md opacity-50 cursor-not-allowed">
                  <ChevronRight className="h-4 w-4" />
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
