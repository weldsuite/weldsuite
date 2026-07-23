import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcall/[callId]/page';

export const Route = createFileRoute('/weldcall/$callId/')({
  component: PageComponent,
});
