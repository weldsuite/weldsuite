import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldforms/share/page';

export const Route = createFileRoute('/preview/weldforms/$formId/share')({
  component: PageComponent,
});
