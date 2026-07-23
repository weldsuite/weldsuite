import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/auth/login/[[...sign-in]]/page';
import { LoginPendingSkeleton } from '@/app/auth/components/login-pending-skeleton';

export const Route = createFileRoute('/auth/login/$')({
  component: PageComponent,
  // Login-shaped pending UI instead of the generic dashboard skeleton, so a
  // cold entry reads as the sign-in form rather than a table.
  pendingComponent: LoginPendingSkeleton,
});
