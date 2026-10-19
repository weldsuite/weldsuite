import { createFileRoute } from '@tanstack/react-router';
import { InvoiceTemplateRedirect } from '@/app/weldbooks/settings/redirects';

// The invoice designer moved under the entity in Settings → Entities.
export const Route = createFileRoute('/weldbooks/settings/invoice-templates/$id/')({
  component: InvoiceTemplateRedirect,
});
