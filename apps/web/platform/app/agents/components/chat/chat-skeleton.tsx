import { Skeleton } from '@weldsuite/ui/components/skeleton';

/** Message-shaped placeholders while an agent's chat opens or its history loads. */
export function ChatSkeleton() {
  return (
    <div className="space-y-6 py-6" aria-busy="true" data-testid="agent-chat-skeleton">
      <div className="flex justify-end">
        <Skeleton className="h-10 w-56 rounded-2xl" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-10 w-40 rounded-2xl" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </div>
  );
}
