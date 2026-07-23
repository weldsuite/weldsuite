
import { useState, useMemo, useCallback } from 'react';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import {
  Star,
  MoreVertical,
  Eye,
  MessageSquare,
  User,
} from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Dialog,
  DialogContent,
} from '@weldsuite/ui/components/dialog';
import type { Review } from '@/hooks/queries/use-helpdesk-queries';
import { format, isValid, parseISO } from 'date-fns';
import { cn } from '@/lib/utils';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig, type ActiveFilter, type RowHandlers } from '@/components/entity-list';

function formatDate(date: string | Date | null | undefined, formatStr: string): string {
  if (!date) return '-';
  const parsed = typeof date === 'string' ? parseISO(date) : date;
  return isValid(parsed) ? format(parsed, formatStr) : '-';
}

interface ReviewsClientProps {
  items: Review[];
}

// Sentiment badge configurations (labels are set dynamically from translations)
const sentimentConfig: Record<string, { className: string }> = {
  positive: {
    className: 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400',
  },
  neutral: {
    className: 'bg-gray-100 text-gray-800 dark:bg-background/20 dark:text-muted-foreground',
  },
  negative: {
    className: 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400',
  },
};

// Status badge configurations (labels are set dynamically from translations)
const statusConfig: Record<string, { className: string }> = {
  pending: {
    className: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400',
  },
  responded: {
    className: 'bg-purple-100 text-purple-800 dark:bg-purple-900/20 dark:text-purple-400',
  },
  resolved: {
    className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400',
  },
};

export function ReviewsClient({ items }: ReviewsClientProps) {
  const { t } = useI18n();
  const tr = t.helpdesk.reviewsPage;
  const [selectedReview, setSelectedReview] = useState<Review | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const handleRowClick = (review: Review) => {
    setSelectedReview(review);
    setIsDialogOpen(true);
  };

  const renderStars = (rating: number) => {
    return (
      <div className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map((star) => (
          <Star
            key={star}
            className={cn(
              'h-3.5 w-3.5',
              star <= rating
                ? 'fill-yellow-400 text-yellow-400'
                : 'fill-gray-200 text-gray-200 dark:fill-white/15 dark:text-gray-700'
            )}
          />
        ))}
      </div>
    );
  };

  // Filter configs
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'sentiment',
      label: tr.sentimentFilter,
      options: [
        { value: 'positive', label: tr.positive },
        { value: 'neutral', label: tr.neutral },
        { value: 'negative', label: tr.negative },
      ],
    },
    {
      field: 'source',
      label: tr.sourceFilter,
      options: [
        { value: 'email', label: t.helpdesk.inbox.channels.email },
        { value: 'chat', label: t.helpdesk.inbox.channels.chat },
        { value: 'website', label: tr.sourceWebsite },
        { value: 'social', label: tr.sourceSocial },
      ],
    },
    {
      field: 'status',
      label: tr.statusFilter,
      options: [
        { value: 'pending', label: tr.pending },
        { value: 'responded', label: tr.responded },
        { value: 'resolved', label: tr.resolved },
      ],
    },
  ], [tr, t.helpdesk.inbox.channels]);

  // Group configs by sentiment
  const groupConfigs: GroupConfig<Review>[] = useMemo(() => [
    {
      id: 'negative',
      label: tr.negative,
      sortOrder: 1,
      filter: (r) => r.sentiment === 'negative',
    },
    {
      id: 'neutral',
      label: tr.neutral,
      sortOrder: 2,
      filter: (r) => r.sentiment === 'neutral',
    },
    {
      id: 'positive',
      label: tr.positive,
      sortOrder: 3,
      filter: (r) => r.sentiment === 'positive',
    },
  ], [tr]);

  // Apply filters
  const applyFilters = useCallback((items: Review[], filters: ActiveFilter[]) => {
    let result = items;

    filters.forEach(filter => {
      if (!filter.operator || !filter.value) return;

      if (filter.field === 'sentiment') {
        result = filter.operator === 'is'
          ? result.filter(r => r.sentiment === filter.value)
          : result.filter(r => r.sentiment !== filter.value);
      } else if (filter.field === 'source') {
        result = filter.operator === 'is'
          ? result.filter(r => r.source === filter.value)
          : result.filter(r => r.source !== filter.value);
      } else if (filter.field === 'status') {
        result = filter.operator === 'is'
          ? result.filter(r => r.status === filter.value)
          : result.filter(r => r.status !== filter.value);
      }
    });

    return result;
  }, []);

  // Header columns
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'customer', header: tr.customer, width: 'w-[220px]' },
    { id: 'rating', header: tr.rating, width: 'w-[140px]' },
    { id: 'comment', header: tr.comment, width: 'flex-1 min-w-[200px]' },
    { id: 'source', header: tr.source, width: 'w-[100px]' },
    { id: 'date', header: tr.date, width: 'w-[120px]' },
    { id: 'status', header: tr.status, width: 'w-[100px]' },
  ], [tr]);

  const sentimentLabels: Record<string, string> = useMemo(() => ({
    positive: tr.positive,
    neutral: tr.neutral,
    negative: tr.negative,
  }), [tr]);

  const statusLabels: Record<string, string> = useMemo(() => ({
    pending: tr.pending,
    responded: tr.responded,
    resolved: tr.resolved,
  }), [tr]);

  // Render row
  const renderRow = useCallback((review: Review, handlers: RowHandlers<Review>) => {
    const sentiment = sentimentConfig[review.sentiment] || sentimentConfig.neutral;
    const status = statusConfig[review.status] || statusConfig.pending;

    return (
      <div
        key={review.id}
        onClick={() => handleRowClick(review)}
        className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group"
      >
        {/* Customer */}
        <div className="w-[220px] flex items-center gap-3">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="text-xs">
              {review.customerName?.split(' ').map(n => n[0]).join('') ?? '?'}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <span className="text-sm font-medium text-gray-900 dark:text-foreground block truncate">
              {review.customerName ?? tr.unknownCustomer}
            </span>
            <span className="text-xs text-gray-500 block truncate">{review.customerEmail}</span>
          </div>
        </div>

        {/* Rating */}
        <div className="w-[140px] flex items-center gap-2">
          {renderStars(review.rating)}
          <span className="text-sm font-medium text-gray-500">{review.rating}.0</span>
        </div>

        {/* Comment */}
        <div className="flex-1 min-w-[200px]">
          <p className="text-sm text-gray-600 dark:text-muted-foreground line-clamp-1">
            {review.comment || '—'}
          </p>
        </div>

        {/* Source */}
        <div className="w-[100px]">
          <Badge variant="outline" className="text-xs capitalize">
            {review.source}
          </Badge>
        </div>

        {/* Date */}
        <div className="w-[120px]">
          <span className="text-sm text-gray-500">{formatDate(review.date, 'MMM d, yyyy')}</span>
        </div>

        {/* Status */}
        <div className="w-[100px]">
          <Badge className={cn('text-xs font-medium rounded-md border-transparent capitalize', status.className)}>
            {statusLabels[review.status] ?? review.status}
          </Badge>
        </div>

        {/* Actions */}
        <div className="w-[40px] flex justify-end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/welddesk/reviews/${review.id}`} className="flex items-center">
                  <Eye className="h-4 w-4 mr-0.5" />
                  {tr.viewDetails}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/welddesk/reviews/${review.id}/reply`} className="flex items-center">
                  <MessageSquare className="h-4 w-4 mr-0.5" />
                  {tr.reply}
                </Link>
              </DropdownMenuItem>
              {review.ticketId && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link href={`/welddesk/tickets/${review.ticketId}`} className="flex items-center">
                      <Eye className="h-4 w-4 mr-0.5" />
                      {tr.viewTicket}
                    </Link>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [statusLabels, tr]);

  return (
    <>
      <EntityList<Review>
        items={items}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={filterConfigs}
        groups={groupConfigs}
        maxFilters={5}
        applyFilters={applyFilters}
        renderRow={renderRow}
        searchPlaceholder={tr.searchPlaceholder}
        searchFields={['customerName', 'customerEmail', 'comment']}
        actionButtons={
          <Button
            variant="outline"
            size="sm"
            className="h-8"
          >
            {tr.refresh}
          </Button>
        }
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" opacity="0.45">
                {/* Review card */}
                <rect x="22" y="28" width="76" height="64" rx="6" className="fill-white dark:fill-white/[0.03] stroke-gray-300 dark:stroke-white/15" strokeWidth="1.2" />
                {/* Avatar circle */}
                <circle cx="40" cy="46" r="8" className="fill-gray-100 dark:fill-white/15 stroke-gray-200 dark:stroke-white/15" strokeWidth="0.8" />
                {/* Name line */}
                <rect x="53" y="42" width="32" height="3.5" rx="1.75" className="fill-gray-200 dark:fill-white/15" />
                {/* Date line */}
                <rect x="53" y="49" width="18" height="2.5" rx="1.25" className="fill-gray-100 dark:fill-white/15" />
                {/* Five small stars */}
                <circle cx="35" cy="65" r="2.5" className="fill-amber-300 dark:fill-amber-400" />
                <circle cx="43" cy="65" r="2.5" className="fill-amber-300 dark:fill-amber-400" />
                <circle cx="51" cy="65" r="2.5" className="fill-amber-300 dark:fill-amber-400" />
                <circle cx="59" cy="65" r="2.5" className="fill-amber-300 dark:fill-amber-400" />
                <circle cx="67" cy="65" r="2.5" className="fill-gray-200 dark:fill-white/20" />
                {/* Review text lines */}
                <rect x="33" y="74" width="54" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" />
                <rect x="33" y="81" width="38" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" />
              </svg>
            </EmptyStateIllustration>
          ),
          title: tr.noReviewsFound,
          description: tr.noReviewsDescription,
        }}
        noResultsState={{
          title: tr.noReviewsFound,
          description: tr.noReviewsMatchFilter,
        }}
      />

      {/* Review Details Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-md p-0 gap-0 overflow-hidden">
          {selectedReview && (
            <div className="p-6">
              {/* Customer */}
              <div className="flex items-center gap-3 mb-5">
                <Avatar className="h-11 w-11 rounded-md">
                  <AvatarFallback className="text-sm bg-gray-100 dark:bg-secondary text-gray-700 dark:text-muted-foreground rounded-md">
                    {selectedReview.customerName?.split(' ').map(n => n[0]).join('') ?? '?'}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <h3 className="font-semibold text-[15px] text-gray-900 dark:text-foreground">
                    {selectedReview.customerName ?? tr.unknownCustomer}
                  </h3>
                  <p className="text-[13px] text-gray-500 dark:text-muted-foreground">
                    {selectedReview.customerEmail}
                  </p>
                </div>
              </div>

              {/* Rating */}
              <div className="flex items-center gap-3 mb-5">
                <div className="flex gap-0.5">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <Star
                      key={star}
                      className={cn(
                        'h-5 w-5',
                        star <= selectedReview.rating
                          ? 'fill-yellow-400 text-yellow-400'
                          : 'fill-gray-200 text-gray-200 dark:fill-white/15 dark:text-gray-700'
                      )}
                    />
                  ))}
                </div>
                <span className="text-base font-medium text-gray-900 dark:text-foreground">
                  {selectedReview.rating}/5
                </span>
              </div>

              {/* Comment */}
              {selectedReview.comment && (
                <div className="mb-5">
                  <p className="text-[14px] text-gray-600 dark:text-muted-foreground leading-relaxed">
                    "{selectedReview.comment}"
                  </p>
                </div>
              )}

              {/* Details */}
              <div className="space-y-2.5 text-[13px]">
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 dark:text-muted-foreground">{tr.date}</span>
                  <span className="text-gray-900 dark:text-foreground">
                    {formatDate(selectedReview.date, 'MMM d, yyyy')}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 dark:text-muted-foreground">{tr.source}</span>
                  <span className="text-gray-900 dark:text-foreground capitalize">
                    {selectedReview.source}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 dark:text-muted-foreground">{tr.status}</span>
                  <Badge className={cn('text-xs font-normal', statusConfig[selectedReview.status]?.className)}>
                    {statusLabels[selectedReview.status] ?? selectedReview.status}
                  </Badge>
                </div>
                {selectedReview.agentName && (
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500 dark:text-muted-foreground">{tr.agentLabel}</span>
                    <span className="text-gray-900 dark:text-foreground">
                      {selectedReview.agentName}
                    </span>
                  </div>
                )}
              </div>

              {/* View Conversation Button */}
              {selectedReview.conversationId && (
                <div className="mt-5 pt-5 border-t border-gray-100 dark:border-border">
                  <Button variant="outline" className="w-full h-10" asChild>
                    <Link href={`/welddesk/inbox/all/${selectedReview.conversationId}`}>
                      {tr.viewConversation}
                    </Link>
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
