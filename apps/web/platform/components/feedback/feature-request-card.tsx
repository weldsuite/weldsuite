
import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Badge } from '@weldsuite/ui/components/badge';
import { cn } from '@/lib/utils';
import { VoteButton } from './vote-button';
import type { FeatureRequest, FeatureType, FeatureStatus } from '@/lib/db/schema/feature-requests';
import { formatDistanceToNow } from 'date-fns';

type FeatureRequestWithVote = FeatureRequest & { hasVoted: boolean };

interface FeatureRequestCardProps {
  request: FeatureRequestWithVote;
  onVoteUpdate?: (updatedRequest: FeatureRequestWithVote) => void;
}

const typeClassName: Record<FeatureType, string> = {
  feature: 'bg-amber-500/10 text-amber-600',
  bug: 'bg-red-500/10 text-red-600',
  improvement: 'bg-blue-500/10 text-blue-600',
};

const statusClassName: Record<FeatureStatus, string> = {
  open: 'bg-green-500/10 text-green-600',
  under_review: 'bg-yellow-500/10 text-yellow-600',
  planned: 'bg-blue-500/10 text-blue-600',
  in_progress: 'bg-purple-500/10 text-purple-600',
  completed: 'bg-emerald-500/10 text-emerald-600',
  declined: 'bg-gray-500/10 text-gray-600',
};

export function FeatureRequestCard({ request, onVoteUpdate }: FeatureRequestCardProps) {
  const t = useTranslations();
  const typeLabels: Record<FeatureType, string> = {
    feature: t('sweep.shared.featureType.feature'),
    bug: t('sweep.shared.featureType.bug'),
    improvement: t('sweep.shared.featureType.improvement'),
  };
  const statusLabels: Record<FeatureStatus, string> = {
    open: t('sweep.shared.featureStatus.open'),
    under_review: t('sweep.shared.featureStatus.underReview'),
    planned: t('sweep.shared.featureStatus.planned'),
    in_progress: t('sweep.shared.featureStatus.inProgress'),
    completed: t('sweep.shared.featureStatus.completed'),
    declined: t('sweep.shared.featureStatus.declined'),
  };
  const typeInfo = { label: typeLabels[request.type], className: typeClassName[request.type] };
  const statusInfo = { label: statusLabels[request.status], className: statusClassName[request.status] };

  const handleVoteChange = (newVoteCount: number, newHasVoted: boolean) => {
    onVoteUpdate?.({
      ...request,
      voteCount: newVoteCount,
      hasVoted: newHasVoted,
    });
  };

  const timeAgo = request.createdAt
    ? formatDistanceToNow(new Date(request.createdAt), { addSuffix: true })
    : '';

  return (
    <div className="flex gap-4 p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors">
      {/* Vote Button */}
      <VoteButton
        featureId={request.id}
        voteCount={request.voteCount}
        hasVoted={request.hasVoted}
        onVoteChange={handleVoteChange}
      />

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-medium text-foreground line-clamp-1">{request.title}</h3>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Badge className={cn('text-xs rounded-sm border-0', typeInfo.className)}>
              {typeInfo.label}
            </Badge>
            <Badge className={cn('text-xs rounded-sm border-0', statusInfo.className)}>
              {statusInfo.label}
            </Badge>
          </div>
        </div>

        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
          {request.description}
        </p>

        <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
          <span>{t('sweep.shared.submittedBy', { name: request.submitterName })}</span>
          <span>&bull;</span>
          <span>{timeAgo}</span>
        </div>
      </div>
    </div>
  );
}
