import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcrm/lists/[listId]/page';

export const Route = createFileRoute('/weldcrm/lists/$listId/')({
  component: PageComponent,
});
