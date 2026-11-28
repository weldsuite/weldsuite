import { useParams } from '@tanstack/react-router';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { EditionUnavailablePage } from '@/components/edition-unavailable-page';
import { isQuotesAvailable, useQuote } from '@/hooks/queries/use-weldbooks-sales-queries';
import { useI18n } from '@/lib/i18n/provider';
import { QuoteForm } from '../../components/quote-form';

export default function EditQuotePage() {
  const { id } = useParams({ strict: false });
  const { t } = useI18n();
  const query = useQuote(id ?? '');

  // The Rust backend only (`books-quotes`); the route guard shows the same page for a direct URL.
  if (!isQuotesAvailable()) return <EditionUnavailablePage />;
  if (query.isLoading) return <PageLoader fullScreen={false} />;
  if (query.isError || !query.data) {
    return <ErrorState message={t.weldbooksSales.quoteForm.loadFailed} onRetry={() => void query.refetch()} />;
  }
  return <QuoteForm mode="edit" quote={query.data} />;
}
