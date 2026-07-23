import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/unified/[labelSlug]/compose/page';

export const Route = createFileRoute('/weldmail/unified/$labelSlug/compose/')({
  component: PageComponent,
});
