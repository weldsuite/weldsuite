import { Skeleton } from '@weldsuite/ui/components/skeleton';

export function ChatPageSkeleton() {
  return (
    <div className="flex flex-col h-full">
      {/* Header skeleton */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b flex-shrink-0">
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-4 rounded" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="flex items-center gap-1">
          <Skeleton className="h-8 w-8 rounded" />
          <Skeleton className="h-8 w-8 rounded" />
          <Skeleton className="h-8 w-8 rounded" />
        </div>
      </div>

      {/* Messages skeleton */}
      <div className="flex-1 overflow-hidden px-4 py-4 space-y-5">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="h-8 w-8 rounded-[10px] flex-shrink-0" />
            <div className="space-y-1.5 flex-1">
              <div className="flex items-center gap-2">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3 w-12" />
              </div>
              <Skeleton className="h-3.5 w-full max-w-[280px]" />
              {i % 2 === 0 && <Skeleton className="h-3.5 w-full max-w-[180px]" />}
            </div>
          </div>
        ))}
      </div>

      {/* Input skeleton */}
      <div className="px-4 pb-4">
        <Skeleton className="h-[42px] w-full rounded-lg" />
      </div>
    </div>
  );
}
