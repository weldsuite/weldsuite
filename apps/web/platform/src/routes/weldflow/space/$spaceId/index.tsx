import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/space/[spaceId]/page';

export const Route = createFileRoute('/weldflow/space/$spaceId/')({
  component: PageComponent,
});
