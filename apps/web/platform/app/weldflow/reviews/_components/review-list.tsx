import { Badge } from '@weldsuite/ui/components/badge';
import type { MyReviews, ReviewBucketValue, ReviewItem, SentReview } from '@weldsuite/app-api-client/domains/flow-approvals';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { formatDate } from '@/app/weldflow/_approvals/format';

const BUCKETS: readonly ReviewBucketValue[] = ['overdue', 'this_week', 'later'];

interface ReviewRowProps {
  review: ReviewItem;
  selected: boolean;
  nameOf: (userId: string | null | undefined) => string;
  onSelect: (id: string) => void;
}

function ReviewRow({ review, selected, nameOf, onSelect }: Readonly<ReviewRowProps>) {
  const { t, language, format } = useI18n();
  const copy = t.flowApprovals.reviews;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(review.id)}
        aria-current={selected ? 'true' : undefined}
        className={cn('flex w-full flex-col gap-1 border-b px-4 py-3 text-left text-sm transition-colors hover:bg-muted/50', selected && 'bg-muted')}
      >
        <span className="flex items-center gap-2">
          <Badge variant="outline">{copy.types[review.type]}</Badge>
          {review.code ? <span className="text-xs text-muted-foreground">{review.code}</span> : null}
          {review.viaDelegation && review.delegatedFrom ? (
            <span className="text-xs text-muted-foreground">{format(copy.viaDelegation, { name: nameOf(review.delegatedFrom) })}</span>
          ) : null}
        </span>
        <span className="font-medium leading-snug">{review.title}</span>
        <span className="text-xs text-muted-foreground">
          {review.projectName ? `${review.projectName} · ` : ''}
          {format(copy.requestedBy, { name: nameOf(review.requestedBy) })}
          {review.dueAt ? ` · ${format(copy.dueOn, { date: formatDate(review.dueAt, language) })}` : ''}
        </span>
      </button>
    </li>
  );
}

interface ReviewBucketsProps {
  groups: MyReviews['groups'];
  selectedId: string | null;
  nameOf: (userId: string | null | undefined) => string;
  onSelect: (id: string) => void;
}

/** The open reviews in their three groups; an empty group is left out. */
export function ReviewBuckets({ groups, selectedId, nameOf, onSelect }: Readonly<ReviewBucketsProps>) {
  const { t } = useI18n();
  return (
    <div>
      {BUCKETS.filter((bucket) => groups[bucket].length > 0).map((bucket) => (
        <section key={bucket} aria-label={t.flowApprovals.reviews.buckets[bucket]}>
          <h3
            className={cn(
              'sticky top-0 z-10 flex items-center gap-2 border-b bg-background px-4 py-2 text-xs font-medium uppercase tracking-wide',
              bucket === 'overdue' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {t.flowApprovals.reviews.buckets[bucket]}
            <span className="rounded-full bg-muted px-1.5 text-[11px] text-foreground">{groups[bucket].length}</span>
          </h3>
          <ul>
            {groups[bucket].map((review) => (
              <ReviewRow key={review.id} review={review} selected={review.id === selectedId} nameOf={nameOf} onSelect={onSelect} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

interface FlatListProps {
  reviews: ReviewItem[];
  selectedId: string | null;
  nameOf: (userId: string | null | undefined) => string;
  onSelect: (id: string) => void;
}

/** A plain list (Done). */
export function ReviewFlatList({ reviews, selectedId, nameOf, onSelect }: Readonly<FlatListProps>) {
  return (
    <ul>
      {reviews.map((review) => (
        <ReviewRow key={review.id} review={review} selected={review.id === selectedId} nameOf={nameOf} onSelect={onSelect} />
      ))}
    </ul>
  );
}

interface SentListProps {
  items: SentReview[];
  nameOf: (userId: string | null | undefined) => string;
}

/** What the caller asked for and who still has to answer. */
export function SentList({ items, nameOf }: Readonly<SentListProps>) {
  const { t, language, format } = useI18n();
  const copy = t.flowApprovals.reviews;
  return (
    <ul>
      {items.map((item) => (
        <li key={`${item.type}-${item.subjectId}`} className="border-b px-4 py-3 text-sm">
          <div className="flex items-center gap-2">
            <Badge variant="outline">{copy.types[item.type]}</Badge>
            {item.code ? <span className="text-xs text-muted-foreground">{item.code}</span> : null}
            <Badge variant="secondary" className="ml-auto">
              {copy.outcome[item.outcome]}
            </Badge>
          </div>
          <p className="mt-1 font-medium">{item.title}</p>
          <p className="text-xs text-muted-foreground">
            {item.projectName ? `${item.projectName} · ` : ''}
            {item.dueAt ? format(copy.dueOn, { date: formatDate(item.dueAt, language) }) : ''}
          </p>
          <ul className="mt-2 space-y-1">
            {item.approvers.map((approver) => (
              <li key={approver.approvalId} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate">{nameOf(approver.approverId)}</span>
                <span className="text-muted-foreground">{copy.decision[approver.decision]}</span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
