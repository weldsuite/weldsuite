import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldforms/form/settings/page';

export const Route = createFileRoute('/preview/weldforms/$formId/settings')({
  component: PageComponent,
});
