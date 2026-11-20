import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/problems/[problemId]/page';

export const Route = createFileRoute('/welddesk/problems/$problemId')({
  component: PageComponent,
});
