import { getRouteApi } from '@tanstack/react-router';
import { InvoiceForm } from '../components/invoice-form';

const routeApi = getRouteApi('/weldbooks/invoices/add/');

export default function AddInvoicePage() {
  // The contact panel's "New invoice" opens this page with that customer picked.
  const { contactId } = routeApi.useSearch();
  return <InvoiceForm mode="add" initialContactId={contactId} />;
}
