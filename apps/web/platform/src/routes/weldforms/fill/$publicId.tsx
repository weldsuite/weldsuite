import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldforms/fill/page';

export const Route = createFileRoute('/weldforms/fill/$publicId')({
  component: PageComponent,
});
