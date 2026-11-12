import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldforms/integrations/page';

export const Route = createFileRoute('/preview/weldforms/$formId/integrations')({
  component: PageComponent,
});
