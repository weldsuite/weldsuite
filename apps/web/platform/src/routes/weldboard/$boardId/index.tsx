import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldboard/board/page';

export const Route = createFileRoute('/weldboard/$boardId/')({
  component: PageComponent,
});
