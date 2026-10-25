import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldsign/templates/editor/page';

export const Route = createFileRoute('/weldsign/templates/$templateId/')({
  component: PageComponent,
});
