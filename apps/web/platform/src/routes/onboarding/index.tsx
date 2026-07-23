import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/onboarding/page';

export const Route = createFileRoute('/onboarding/')({
  component: PageComponent,
});
