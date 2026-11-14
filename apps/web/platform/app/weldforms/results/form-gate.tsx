/**
 * Loads the form a share / results / integrations page belongs to and handles
 * the states every such page shares: loading, a failed load, a form that does
 * not exist (or is a 404 to this member), then hands the detail to the page.
 */

import type { ReactNode } from 'react';
import { isApiError } from '@weldsuite/api-client';
import type { FormDetail } from '@weldsuite/app-api-client/schemas/weldforms';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { FileQuestion } from 'lucide-react';
import { useForm } from '@/hooks/queries/use-weldforms-queries';
import { useI18n } from '@/lib/i18n/provider';

/** The server's message for a failed request, or the fallback. */
export function errorMessage(err: unknown, fallback: string): string {
  if (isApiError(err)) {
    const body = err.body as { error?: { message?: string } } | undefined;
    const message = body?.error?.message;
    if (message) return message;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

export function FormGate({
  formId,
  children,
}: Readonly<{ formId: string; children: (form: FormDetail) => ReactNode }>) {
  const { t } = useI18n();
  const tc = t.weldformsResults.common;
  const { data: form, isLoading, error, refetch } = useForm(formId);

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (error || !form) {
    if (isApiError(error) && error.status === 404) {
      return (
        <div className="p-6">
          <EmptyState icon={FileQuestion} title={tc.notFoundTitle} description={tc.notFoundDescription} />
        </div>
      );
    }
    return (
      <div className="p-6">
        <ErrorState message={tc.loadFailed} onRetry={() => void refetch()} retryLabel={tc.retry} />
      </div>
    );
  }
  return <>{children(form)}</>;
}

/** The page frame the three tabs share: a centred column with the page gutter. */
export function FormTabFrame({ children, wide = false }: Readonly<{ children: ReactNode; wide?: boolean }>) {
  return (
    <div className={`mx-auto w-full space-y-6 p-4 md:p-6 ${wide ? 'max-w-7xl' : 'max-w-5xl'}`}>{children}</div>
  );
}
