'use client';

import { useQueryErrorResetBoundary } from '@tanstack/react-query';
import { ErrorState } from '@/components/ui/states';

/** A page's data failed to load. Retry clears the failed queries and renders the page again. */
export default function PortalError({ reset }: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  const { reset: resetQueries } = useQueryErrorResetBoundary();
  return (
    <ErrorState
      onRetry={() => {
        resetQueries();
        reset();
      }}
    />
  );
}
