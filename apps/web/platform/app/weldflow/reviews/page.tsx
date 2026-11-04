import { useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Loader2, UserRoundCog } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import type { ReviewItem, ReviewType } from '@weldsuite/app-api-client/domains/flow-approvals';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useMyReviews, useReviewsDone, useReviewsSent } from '@/hooks/queries/use-flow-approvals-queries';
import { useMemberNames } from '@/app/weldflow/_approvals/use-member-names';
import { DelegationDialog } from './_components/delegation-dialog';
import { ReviewDetail } from './_components/review-detail';
import { ReviewBuckets, ReviewFlatList, SentList } from './_components/review-list';

type View = 'mine' | 'sent' | 'done';
const VIEWS: readonly View[] = ['mine', 'sent', 'done'];
const TYPES: readonly ReviewType[] = [
  'change_request',
  'risk_acceptance',
  'decision',
  'deliverable',
  'gate',
  'project_request',
  'project_close',
  'timesheet',
];

function Message({ text, action }: Readonly<{ text: string; action?: { label: string; onClick: () => void } }>) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center text-sm text-muted-foreground">
      <p>{text}</p>
      {action ? (
        <Button type="button" variant="outline" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

/** My reviews: everything waiting for the caller's answer, what they sent and what they answered. */
export default function MyReviewsPage() {
  const { t } = useI18n();
  const copy = t.flowApprovals.reviews;
  const { userId } = useAuth();
  const { members, nameOf } = useMemberNames();
  const [view, setView] = useState<View>('mine');
  const [type, setType] = useState<ReviewType | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [delegating, setDelegating] = useState(false);

  const mine = useMyReviews(type ? { type } : {});
  const sent = useReviewsSent(type ? { type } : {}, view === 'sent');
  const done = useReviewsDone(type ? { type } : {}, view === 'done');

  const reviews = mine.data;
  const doneItems = useMemo(() => done.data?.pages.flatMap((page) => page.data) ?? [], [done.data]);
  const sentItems = useMemo(() => sent.data?.pages.flatMap((page) => page.data) ?? [], [sent.data]);
  const selectable: ReviewItem[] = view === 'mine' ? [...(reviews?.groups.overdue ?? []), ...(reviews?.groups.this_week ?? []), ...(reviews?.groups.later ?? [])] : view === 'done' ? doneItems : [];
  const selected = selectable.find((review) => review.id === selectedId) ?? null;

  const active = view === 'mine' ? mine : view === 'sent' ? sent : done;

  let list: React.ReactNode;
  if (active.isLoading) {
    list = (
      <div className="flex justify-center py-16" role="status">
        <Loader2 className="animate-spin text-muted-foreground" aria-hidden />
      </div>
    );
  } else if (active.isError) {
    list = <Message text={t.flowApprovals.common.loadFailed} action={{ label: t.flowApprovals.common.retry, onClick: () => void active.refetch() }} />;
  } else if (view === 'mine') {
    list =
      reviews && reviews.total > 0 ? (
        <ReviewBuckets groups={reviews.groups} selectedId={selectedId} nameOf={nameOf} onSelect={setSelectedId} />
      ) : (
        <Message text={type ? copy.emptyFiltered : copy.empty} />
      );
  } else if (view === 'sent') {
    list = sentItems.length > 0 ? <SentList items={sentItems} nameOf={nameOf} /> : <Message text={copy.emptySent} />;
  } else {
    list = doneItems.length > 0 ? <ReviewFlatList reviews={doneItems} selectedId={selectedId} nameOf={nameOf} onSelect={setSelectedId} /> : <Message text={copy.emptyDone} />;
  }
  const paged = view === 'sent' ? sent : view === 'done' ? done : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="my-reviews">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">{t.flowApprovals.title}</h1>
          <p className="text-sm text-muted-foreground">{copy.subtitle}</p>
        </div>
        <div role="tablist" className="flex rounded-md border p-0.5">
          {VIEWS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={view === candidate}
              onClick={() => {
                setView(candidate);
                setSelectedId(null);
              }}
              className={cn('rounded px-3 py-1 text-sm', view === candidate ? 'bg-muted font-medium' : 'text-muted-foreground')}
            >
              {copy.views[candidate]}
            </button>
          ))}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setDelegating(true)}>
          <UserRoundCog aria-hidden />
          {copy.delegate}
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5 border-b px-4 py-2" role="group" aria-label={copy.all}>
        <button
          type="button"
          aria-pressed={!type}
          onClick={() => setType(undefined)}
          className={cn('rounded-full border px-3 py-1 text-xs', !type ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted')}
        >
          {copy.all}
          {view === 'mine' && reviews ? ` ${Object.values(reviews.counts).reduce((sum, count) => sum + count, 0)}` : ''}
        </button>
        {TYPES.filter((candidate) => view !== 'mine' || candidate === type || (reviews?.counts[candidate] ?? 0) > 0).map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={type === candidate}
            onClick={() => setType(type === candidate ? undefined : candidate)}
            className={cn('rounded-full border px-3 py-1 text-xs', type === candidate ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted')}
          >
            {copy.types[candidate]}
            {view === 'mine' && reviews?.counts[candidate] ? ` ${reviews.counts[candidate]}` : ''}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className={cn('min-h-0 w-full overflow-y-auto lg:w-[26rem] lg:shrink-0 lg:border-r', selected && 'hidden lg:block')}>
          {list}
          {paged?.hasNextPage ? (
            <div className="flex justify-center p-3">
              <Button type="button" variant="outline" size="sm" disabled={paged.isFetchingNextPage} onClick={() => void paged.fetchNextPage()}>
                {t.flowApprovals.common.loadMore}
              </Button>
            </div>
          ) : null}
        </div>
        <div className={cn('min-h-0 flex-1', !selected && 'hidden lg:block')}>
          {selected ? (
            <ReviewDetail review={selected} nameOf={nameOf} readOnly={view === 'done'} onClose={() => setSelectedId(null)} />
          ) : (
            <Message text={copy.selectReview} />
          )}
        </div>
      </div>

      <DelegationDialog open={delegating} onOpenChange={setDelegating} members={members} currentUserId={userId} nameOf={nameOf} />
    </div>
  );
}
