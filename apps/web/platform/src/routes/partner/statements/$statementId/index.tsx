import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/partner/statements/detail-page';

export const Route = createFileRoute('/partner/statements/$statementId/')({
  component: PageComponent,
});
