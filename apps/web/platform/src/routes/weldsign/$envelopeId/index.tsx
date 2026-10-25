import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldsign/envelope/page';

export const Route = createFileRoute('/weldsign/$envelopeId/')({
  component: PageComponent,
});
