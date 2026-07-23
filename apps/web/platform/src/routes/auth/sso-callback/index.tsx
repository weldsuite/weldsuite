import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/auth/sso-callback/page';

export const Route = createFileRoute('/auth/sso-callback/')({
  component: PageComponent,
});
