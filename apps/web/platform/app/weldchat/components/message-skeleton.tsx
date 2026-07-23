import { Skeleton } from '@weldsuite/ui/components/skeleton';

interface MessageSkeletonProps {
  count?: number;
}

export function MessageSkeleton({ count = 5 }: MessageSkeletonProps) {
  return (
    <div className="space-y-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="h-8 w-8 rounded-full flex-shrink-0" />
          <div className="space-y-2 flex-1">
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="h-4 w-full max-w-[300px]" />
            {i % 3 === 0 && <Skeleton className="h-4 w-full max-w-[200px]" />}
          </div>
        </div>
      ))}
    </div>
  );
}
