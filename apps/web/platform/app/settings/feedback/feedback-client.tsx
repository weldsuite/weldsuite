
import * as React from 'react';
import { useState, useTransition } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { FeatureRequestCard } from '@/components/feedback/feature-request-card';
import { SubmitFeatureDialog } from '@/components/feedback/submit-feature-dialog';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { FeatureRequest, FeatureType, FeatureStatus } from '@/lib/db/schema/feature-requests';
import { useI18n } from '@/lib/i18n/provider';

type FeatureRequestWithVote = FeatureRequest & { hasVoted: boolean };

interface FeedbackClientProps {
  initialRequests: FeatureRequestWithVote[];
  initialStats: {
    total: number;
    open: number;
    underReview: number;
    planned: number;
    inProgress: number;
    completed: number;
    declined: number;
    features: number;
    bugs: number;
    improvements: number;
  } | null;
}

export function FeedbackClient({ initialRequests, initialStats }: FeedbackClientProps) {
  const { t } = useI18n();
  const ts = t.settings.feedback;
  const [requests, setRequests] = useState(initialRequests);
  const [filter, setFilter] = useState<'all' | FeatureType>('all');
  const [sortBy, setSortBy] = useState<'votes' | 'newest' | 'oldest'>('votes');
  const [submitDialogOpen, setSubmitDialogOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const { getClient } = useAppApiClient();

  const stats = initialStats;

  const fetchRequests = async (params: { type?: string; sortBy: string }) => {
    const client = await getClient();
    const queryParams = new URLSearchParams();
    if (params.type) queryParams.set('type', params.type);
    if (params.sortBy) queryParams.set('sortBy', params.sortBy);
    const query = queryParams.toString() ? `?${queryParams.toString()}` : '';
    return client.get<{ data?: FeatureRequestWithVote[] }>(`/feature-requests${query}`);
  };

  const refreshRequests = () => {
    startTransition(async () => {
      const result = await fetchRequests({
        type: filter === 'all' ? undefined : filter,
        sortBy,
      });
      if (result.data) {
        setRequests(result.data);
      }
    });
  };

  const handleFilterChange = (value: string) => {
    setFilter(value as 'all' | FeatureType);
    startTransition(async () => {
      const result = await fetchRequests({
        type: value === 'all' ? undefined : value,
        sortBy,
      });
      if (result.data) {
        setRequests(result.data);
      }
    });
  };

  const handleSortChange = (value: string) => {
    setSortBy(value as 'votes' | 'newest' | 'oldest');
    startTransition(async () => {
      const result = await fetchRequests({
        type: filter === 'all' ? undefined : filter,
        sortBy: value,
      });
      if (result.data) {
        setRequests(result.data);
      }
    });
  };

  const handleVoteUpdate = (updatedRequest: FeatureRequestWithVote) => {
    setRequests(prev =>
      prev.map(r => (r.id === updatedRequest.id ? updatedRequest : r))
    );
  };

  const handleSubmitSuccess = () => {
    refreshRequests();
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Page Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{ts.title}</h1>
          <p className="text-muted-foreground">{ts.description}</p>
        </div>
        <Button onClick={() => setSubmitDialogOpen(true)} className="rounded-lg">
          {ts.submitIdea}
        </Button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="px-4 py-3 rounded-lg border bg-card">
            <p className="text-xl font-semibold">{stats.total}</p>
            <p className="text-sm font-medium text-muted-foreground mt-1">{ts.total}</p>
          </div>
          <div className="px-4 py-3 rounded-lg border bg-card">
            <p className="text-xl font-semibold">{stats.open}</p>
            <p className="text-sm font-medium text-muted-foreground mt-1">{ts.open}</p>
          </div>
          <div className="px-4 py-3 rounded-lg border bg-card">
            <p className="text-xl font-semibold">{stats.planned}</p>
            <p className="text-sm font-medium text-muted-foreground mt-1">{ts.planned}</p>
          </div>
          <div className="px-4 py-3 rounded-lg border bg-card">
            <p className="text-xl font-semibold">{stats.completed}</p>
            <p className="text-sm font-medium text-muted-foreground mt-1">{ts.completed}</p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center justify-between">
        <div className="inline-flex rounded-lg border">
          <Button
            variant="ghost"
            onClick={() => handleFilterChange('all')}
            className={`px-4 py-2 text-sm font-medium transition-colors rounded-r-none ${
              filter === 'all'
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            } rounded-l-lg`}
          >
            {ts.all}
          </Button>
          <Button
            variant="ghost"
            onClick={() => handleFilterChange('feature')}
            className={`px-4 py-2 text-sm font-medium transition-colors border-l rounded-none ${
              filter === 'feature'
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
          >
            {ts.features}
          </Button>
          <Button
            variant="ghost"
            onClick={() => handleFilterChange('bug')}
            className={`px-4 py-2 text-sm font-medium transition-colors border-l rounded-none ${
              filter === 'bug'
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
          >
            {ts.bugs}
          </Button>
          <Button
            variant="ghost"
            onClick={() => handleFilterChange('improvement')}
            className={`px-4 py-2 text-sm font-medium transition-colors border-l rounded-l-none ${
              filter === 'improvement'
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            } rounded-r-lg`}
          >
            {ts.improvements}
          </Button>
        </div>

        <Select value={sortBy} onValueChange={handleSortChange}>
          <SelectTrigger className="w-[140px] focus:ring-0 focus:ring-offset-0 focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-input focus-visible:border-input">
            <SelectValue placeholder={ts.sortBy} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="votes">{ts.mostVoted}</SelectItem>
            <SelectItem value="newest">{ts.newest}</SelectItem>
            <SelectItem value="oldest">{ts.oldest}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Request List */}
      <div className="space-y-3">
        {isPending ? (
          <div className="flex items-center justify-center gap-2 py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{ts.loading}</span>
          </div>
        ) : requests.length === 0 ? (
          <div className="text-center py-12 border rounded-lg bg-muted/50">
            <h3 className="text-lg font-medium mb-2">{ts.noRequests}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {ts.noRequestsDescription}
            </p>
            <Button onClick={() => setSubmitDialogOpen(true)}>
              {ts.submitIdea}
            </Button>
          </div>
        ) : (
          requests.map(request => (
            <FeatureRequestCard
              key={request.id}
              request={request}
              onVoteUpdate={handleVoteUpdate}
            />
          ))
        )}
      </div>

      {/* Submit Dialog */}
      <SubmitFeatureDialog
        open={submitDialogOpen}
        onOpenChange={setSubmitDialogOpen}
        onSuccess={handleSubmitSuccess}
      />
    </div>
  );
}
