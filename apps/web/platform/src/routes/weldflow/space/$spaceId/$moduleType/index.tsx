import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/space/[spaceId]/[moduleType]/page';

export const Route = createFileRoute('/weldflow/space/$spaceId/$moduleType/')({
  component: PageComponent,
});
