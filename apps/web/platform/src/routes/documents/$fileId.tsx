import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/documents/[fileId]/page';

export const Route = createFileRoute('/documents/$fileId')({
  component: PageComponent,
});
