import { EditionUnavailablePage } from '@/components/edition-unavailable-page';
import { isQuotesAvailable } from '@/hooks/queries/use-weldbooks-sales-queries';
import { QuoteForm } from '../components/quote-form';

export default function AddQuotePage() {
  // The Rust backend only (`books-quotes`); the route guard shows the same page for a direct URL.
  if (!isQuotesAvailable()) return <EditionUnavailablePage />;
  return <QuoteForm mode="add" />;
}
