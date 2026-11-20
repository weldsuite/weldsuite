import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldforms/results/page';
import { parseResultsSearch } from '@/app/weldforms/results/search';

export const Route = createFileRoute('/weldforms/$formId/results')({
  validateSearch: parseResultsSearch,
  component: PageComponent,
});
