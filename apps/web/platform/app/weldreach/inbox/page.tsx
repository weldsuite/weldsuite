/**
 * The WeldReach reply inbox: conversations on the left (filters for state,
 * label, campaign and mailbox; refreshed every 30 seconds), the open
 * conversation on the right. `?thread=<key>` makes a conversation linkable.
 */

import { useMemo, useState } from 'react';
import { MessagesSquare, RefreshCw } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { ReachReplyLabel } from '@weldsuite/app-api-client/schemas/reach';
import { useRouter, useSearchParams } from '@/lib/router';
import { cn } from '@/lib/utils';
import { useReachCampaigns } from '@/hooks/queries/use-reach-campaign-queries';
import { useReachMailboxes } from '@/hooks/queries/use-reach-queries';
import {
  useReachThreads,
  useReachUnreadCount,
  type ReachInboxFilters,
} from '@/hooks/queries/use-reach-inbox-queries';
import { REPLY_LABEL_ORDER, replyLabelKey } from '@/app/weldreach/components/engage/badges';
import { useReachFormat } from '@/app/weldreach/components/engage/format';
import {
  ErrorBanner,
  FilterSelect,
  InlineSpinner,
  emptyIcon,
  errorMessage,
  useReachBreadcrumbs,
} from '@/app/weldreach/components/engage/kit';
import { ThreadList } from './components/thread-list';
import { ThreadView } from './components/thread-view';
import { INBOX_STATES, type InboxState } from './lib/thread-state';

const STATE_KEYS: Record<InboxState, string> = {
  open: 'reachEngage.inbox.states.open',
  unread: 'reachEngage.inbox.states.unread',
  handled: 'reachEngage.inbox.states.handled',
  all: 'reachEngage.inbox.states.all',
};

type ThreadsQuery = ReturnType<typeof useReachThreads>;

/** The conversation list, or what stands in for it while loading, on error and when empty. */
function ThreadsBody({
  threads,
  selectedKey,
  emptyTitle,
  emptyDescription,
  onSelect,
}: Readonly<{
  threads: ThreadsQuery;
  selectedKey: string | undefined;
  emptyTitle: string;
  emptyDescription: string;
  onSelect: (threadKey: string) => void;
}>) {
  const t = useTranslations();

  if (threads.isLoading) return <InlineSpinner />;
  if (threads.isError && threads.threads.length === 0) {
    return (
      <div className="p-4">
        <ErrorBanner error={errorMessage(threads.error, t('reachEngage.inbox.loadFailed'))} />
      </div>
    );
  }
  if (threads.threads.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
        {emptyIcon(MessagesSquare)}
        <p className="text-sm font-medium">{emptyTitle}</p>
        <p className="max-w-xs text-sm text-muted-foreground">{emptyDescription}</p>
      </div>
    );
  }

  return (
    <ThreadList
      threads={threads.threads}
      selectedKey={selectedKey}
      hasMore={threads.hasNextPage}
      isLoadingMore={threads.isFetchingNextPage}
      onSelect={onSelect}
      onLoadMore={() => void threads.fetchNextPage()}
    />
  );
}

export default function ReachInboxPage() {
  const t = useTranslations();
  const router = useRouter();
  const format = useReachFormat();
  const { can } = usePermissions();
  const searchParams = useSearchParams();
  useReachBreadcrumbs({ label: t('reachEngage.inbox.title') });

  const threadKey = searchParams.get('thread') ?? undefined;
  const [state, setState] = useState<InboxState>('open');
  const [label, setLabel] = useState<ReachReplyLabel | undefined>(undefined);
  const [campaignId, setCampaignId] = useState<string | undefined>(undefined);
  const [mailboxId, setMailboxId] = useState<string | undefined>(undefined);

  const filters = useMemo<ReachInboxFilters>(
    () => ({ state, label, campaignId, mailboxId }),
    [state, label, campaignId, mailboxId],
  );
  const hasExtraFilters = label !== undefined || campaignId !== undefined || mailboxId !== undefined;

  const canRead = can('reach_inbox:read');
  const threads = useReachThreads(filters);
  const unread = useReachUnreadCount({ enabled: canRead });
  const campaigns = useReachCampaigns();
  const mailboxes = useReachMailboxes();

  function open(key: string) {
    router.replace(`/weldreach/inbox?thread=${encodeURIComponent(key)}`);
  }

  function close() {
    router.replace('/weldreach/inbox');
  }

  const emptyTitle =
    state === 'open' && !hasExtraFilters
      ? t('reachEngage.inbox.emptyTitle')
      : t('reachEngage.inbox.noResultsTitle');
  const emptyDescription =
    state === 'open' && !hasExtraFilters
      ? t('reachEngage.inbox.emptyDescription')
      : t('reachEngage.inbox.noResultsDescription');

  return (
    <div className="flex h-full min-h-0">
      <section
        aria-label={t('reachEngage.inbox.conversations')}
        className={cn(
          'flex min-h-0 w-full flex-col md:w-[400px] md:shrink-0 md:border-r lg:w-[440px]',
          threadKey && 'hidden md:flex',
        )}
      >
        <div className="space-y-2 border-b px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <Tabs value={state} onValueChange={(value) => setState(value as InboxState)}>
              <TabsList className="h-8">
                {INBOX_STATES.map((value) => (
                  <TabsTrigger key={value} value={value} className="px-2.5 text-xs">
                    {t(STATE_KEYS[value])}
                    {value === 'unread' && (unread.data ?? 0) > 0 && (
                      <span className="ml-1.5 rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                        {format.number(unread.data ?? 0)}
                      </span>
                    )}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              disabled={threads.isFetching}
              onClick={() => void threads.refetch()}
              aria-label={t('reachEngage.inbox.refresh')}
            >
              <RefreshCw className={cn('h-4 w-4', threads.isFetching && 'animate-spin')} />
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            <FilterSelect
              value={label}
              onChange={(next) => setLabel(next as ReachReplyLabel | undefined)}
              options={REPLY_LABEL_ORDER.map((value) => ({ value, label: t(replyLabelKey(value)) }))}
              allLabel={t('reachEngage.inbox.allLabels')}
              ariaLabel={t('reachEngage.inbox.labelFilter')}
            />
            <FilterSelect
              value={campaignId}
              onChange={setCampaignId}
              options={campaigns.campaigns.map((campaign) => ({ value: campaign.id, label: campaign.name }))}
              allLabel={t('reachEngage.inbox.allCampaigns')}
              ariaLabel={t('reachEngage.inbox.campaignFilter')}
              className="max-w-[11rem]"
            />
            <FilterSelect
              value={mailboxId}
              onChange={setMailboxId}
              options={(mailboxes.data ?? []).map((mailbox) => ({ value: mailbox.id, label: mailbox.email }))}
              allLabel={t('reachEngage.inbox.allMailboxes')}
              ariaLabel={t('reachEngage.inbox.mailboxFilter')}
              className="max-w-[11rem]"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <ThreadsBody
            threads={threads}
            selectedKey={threadKey}
            emptyTitle={emptyTitle}
            emptyDescription={emptyDescription}
            onSelect={open}
          />
        </div>
      </section>

      <section
        aria-label={t('reachEngage.inbox.conversation')}
        className={cn('min-w-0 flex-1 flex-col', threadKey ? 'flex' : 'hidden md:flex')}
      >
        {threadKey ? (
          <ThreadView key={threadKey} threadKey={threadKey} onBack={close} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
            <MessagesSquare className="h-8 w-8" strokeWidth={1.5} />
            <p className="text-sm">{t('reachEngage.inbox.selectPrompt')}</p>
          </div>
        )}
      </section>
    </div>
  );
}
