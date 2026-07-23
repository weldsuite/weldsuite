import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/unified/[labelSlug]/page';

export const Route = createFileRoute('/weldmail/unified/$labelSlug/')({
  component: PageComponent,
});
