import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldforms/integrations/page';

export const Route = createFileRoute('/weldforms/$formId/integrations')({
  component: PageComponent,
});
