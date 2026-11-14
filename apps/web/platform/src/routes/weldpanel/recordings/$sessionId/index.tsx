import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/recordings/detail/page';

export const Route = createFileRoute('/weldpanel/recordings/$sessionId/')({
  component: PageComponent,
});
