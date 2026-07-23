
import * as React from 'react';
import { useState } from 'react';
import { ChevronUp } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { useMutation } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

interface VoteButtonProps {
  featureId: string;
  voteCount: number;
  hasVoted: boolean;
  onVoteChange?: (newVoteCount: number, newHasVoted: boolean) => void;
}

export function VoteButton({
  featureId,
  voteCount,
  hasVoted,
  onVoteChange,
}: VoteButtonProps) {
  const [optimisticVoteCount, setOptimisticVoteCount] = useState(voteCount);
  const [optimisticHasVoted, setOptimisticHasVoted] = useState(hasVoted);
  const { getClient } = useAppApiClient();

  const voteMutation = useMutation({
    mutationFn: async () => {
      const client = await getClient();
      return client.post<{ data?: { voteCount: number; voters?: string[]; hasVoted: boolean } }>(`/feature-requests/${featureId}/vote`, {});
    },
  });

  const isPending = voteMutation.isPending;

  const handleVote = async () => {
    // Optimistic update
    const newHasVoted = !optimisticHasVoted;
    const newVoteCount = newHasVoted
      ? optimisticVoteCount + 1
      : optimisticVoteCount - 1;

    setOptimisticHasVoted(newHasVoted);
    setOptimisticVoteCount(newVoteCount);

    try {
      const result = await voteMutation.mutateAsync();

      if (result.data) {
        const actualVoteCount = result.data.voteCount;

        setOptimisticVoteCount(actualVoteCount);
        onVoteChange?.(actualVoteCount, newHasVoted);
      } else {
        // Revert on error
        setOptimisticHasVoted(!newHasVoted);
        setOptimisticVoteCount(newHasVoted ? newVoteCount - 1 : newVoteCount + 1);
      }
    } catch {
      // Revert on error
      setOptimisticHasVoted(!newHasVoted);
      setOptimisticVoteCount(newHasVoted ? newVoteCount - 1 : newVoteCount + 1);
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleVote}
      disabled={isPending}
      className={cn(
        'flex flex-col items-center justify-center h-auto min-w-[48px] px-2 py-2 rounded-lg border transition-all',
        'hover:border-primary/50',
        optimisticHasVoted
          ? 'bg-primary/10 border-primary text-primary'
          : 'bg-muted/50 border-border text-muted-foreground hover:text-foreground',
        isPending && 'opacity-50 cursor-not-allowed'
      )}
    >
      <ChevronUp
        className={cn(
          'h-4 w-4 transition-transform',
          optimisticHasVoted && 'text-primary'
        )}
      />
      <span className={cn('text-sm font-semibold', optimisticHasVoted && 'text-primary')}>
        {optimisticVoteCount}
      </span>
    </Button>
  );
}
