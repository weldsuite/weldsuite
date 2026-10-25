import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddocs/doc/page';

export const Route = createFileRoute('/welddocs/$docId/')({
  component: PageComponent,
});
