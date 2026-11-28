import { getRouteApi } from '@tanstack/react-router';
import { EditionUnavailablePage } from '@/components/edition-unavailable-page';
import { isQuotesAvailable } from '@/hooks/queries/use-weldbooks-sales-queries';
import { QuoteForm } from '../components/quote-form';

const routeApi = getRouteApi('/weldbooks/quotes/add/');

export default function AddQuotePage() {
  // The contact page's "New quote" opens this page with that customer picked.
  const { contactId } = routeApi.useSearch();
  // The Rust backend only (`books-quotes`); the route guard shows the same page for a direct URL.
  if (!isQuotesAvailable()) return <EditionUnavailablePage />;
  return <QuoteForm mode="add" initialContactId={contactId} />;
}
