/**
 * A failed query. A 503 means analytics isn't connected in this environment:
 * a calm notice, not an error. A 403 names the missing permission; anything
 * else offers a retry.
 */

import { CloudOff } from 'lucide-react';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { useI18n } from '@/lib/i18n/provider';
import { isAnalyticsUnavailable, isForbidden } from '../lib/query-error';

interface QueryErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}

export function QueryErrorState({ error, onRetry, className }: Readonly<QueryErrorStateProps>) {
  const { t } = useI18n();
  const te = t.weldpanel.analytics.errors;
  if (isAnalyticsUnavailable(error)) {
    return <EmptyState className={className} icon={CloudOff} title={te.notConfiguredTitle} description={te.notConfigured} />;
  }
  if (isForbidden(error)) return <ErrorState className={className} message={te.forbidden} />;
  return <ErrorState className={className} message={te.loadFailed} onRetry={onRetry} retryLabel={te.retry} />;
}
