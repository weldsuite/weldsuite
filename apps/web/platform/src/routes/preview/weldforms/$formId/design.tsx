import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldforms/form/design/page';

export const Route = createFileRoute('/preview/weldforms/$formId/design')({
  component: PageComponent,
});
