import { Button } from '@weldsuite/ui/components/button';

/**
 * Shown by a WeldFlow list page when its query failed. Without it a failed load
 * fell through to the "No tasks yet" empty state, which reads as if the data
 * were gone.
 */
export function ListLoadError({
  message,
  retryLabel,
  onRetry,
}: Readonly<{ message: string; retryLabel: string; onRetry: () => void }>) {
  return (
    <div role="alert" className="flex h-full min-h-[240px] items-center justify-center p-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <p className="text-sm text-destructive">{message}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {retryLabel}
        </Button>
      </div>
    </div>
  );
}
