import { Link, type ErrorComponentProps } from '@tanstack/react-router';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { PageBody, PageContent } from '@/components/shell/admin-shell';

/** What a page shows when its loader failed (Next showed its error overlay or a 500). */
export function RouteError({ error, reset }: Readonly<ErrorComponentProps>) {
  return (
    <PageContent>
      <PageBody width="narrow">
        <ErrorState message={error instanceof Error ? error.message : undefined} onRetry={reset} />
      </PageBody>
    </PageContent>
  );
}

/** A record that doesn't exist, or a path no route serves. */
export function NotFound() {
  return (
    <PageContent>
      <PageBody width="narrow">
        <EmptyState
          title="Not found"
          description="There is nothing here."
          action={
            <Link to="/" className="text-sm underline underline-offset-2">
              Back to the dashboard
            </Link>
          }
        />
      </PageBody>
    </PageContent>
  );
}
