import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldforms/form/logic/page';

export const Route = createFileRoute('/preview/weldforms/$formId/logic')({
  component: PageComponent,
});
