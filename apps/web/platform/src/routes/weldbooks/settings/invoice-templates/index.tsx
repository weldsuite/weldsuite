import { createFileRoute } from '@tanstack/react-router';
import { InvoiceTemplatesRedirect } from '@/app/weldbooks/settings/redirects';

// The invoice templates moved under the entity in Settings → Entities.
export const Route = createFileRoute('/weldbooks/settings/invoice-templates/')({
  component: InvoiceTemplatesRedirect,
});
