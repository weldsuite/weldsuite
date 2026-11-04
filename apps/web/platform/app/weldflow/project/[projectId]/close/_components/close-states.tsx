import { AlertCircle, FolderX, Lock } from 'lucide-react';
import { isApiError } from '@weldsuite/api-client';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { useI18n } from '@/lib/i18n/provider';

/** Placeholders while the checklist loads. */
export function CloseLoadingState() {
  const { t } = useI18n();
  return (
    <div role="status" aria-busy="true" aria-label={t.flowClosing.close.states.loadingLabel} className="flex flex-col gap-4">
      <Skeleton className="h-16 rounded-lg" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-96 rounded-xl" />
        <div className="flex flex-col gap-4">
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

/** The checklist could not be loaded: no access, not found, or a failure that can be retried. */
export function CloseErrorState({ error, onRetry }: Readonly<{ error: unknown; onRetry: () => void }>) {
  const { t } = useI18n();
  const copy = t.flowClosing.close.states;
  const status = isApiError(error) ? error.status : null;
  let state = { Icon: AlertCircle, title: copy.errorTitle, description: copy.errorDescription };
  if (status === 403) state = { Icon: Lock, title: copy.forbiddenTitle, description: copy.forbiddenDescription };
  else if (status === 404) state = { Icon: FolderX, title: copy.notFoundTitle, description: copy.notFoundDescription };
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-16 text-center">
      <div className="rounded-full bg-muted p-3">
        <state.Icon aria-hidden className="size-6 text-muted-foreground" />
      </div>
      <h2 className="text-base font-semibold">{state.title}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{state.description}</p>
      {status !== 403 && status !== 404 ? (
        <Button type="button" variant="outline" onClick={onRetry}>
          {copy.retry}
        </Button>
      ) : null}
    </div>
  );
}
