import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/form-1099/filings/[id]/page';

export const Route = createFileRoute('/weldbooks/form-1099/filings/$id/')({
  component: PageComponent,
});
