import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddocs/doc/page';
import { DocSkeleton } from '@/app/welddocs/doc/doc-skeleton';

export const Route = createFileRoute('/preview/welddocs/$docId/')({
  component: PageComponent,
  // A document-shaped placeholder instead of the generic dashboard skeleton.
  pendingComponent: DocSkeleton,
});
