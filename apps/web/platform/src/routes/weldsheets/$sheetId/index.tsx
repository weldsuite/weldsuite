import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldsheets/sheet/page';

export const Route = createFileRoute('/weldsheets/$sheetId/')({
  component: PageComponent,
});
