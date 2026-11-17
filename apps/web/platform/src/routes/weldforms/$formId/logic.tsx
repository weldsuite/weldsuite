import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldforms/form/logic/page';
import { parseLogicSearch } from '@/app/weldforms/form/logic/search';

export const Route = createFileRoute('/weldforms/$formId/logic')({
  validateSearch: parseLogicSearch,
  component: PageComponent,
});
