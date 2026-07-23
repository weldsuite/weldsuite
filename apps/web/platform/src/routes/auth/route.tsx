import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/auth/layout';
import { LoginPendingSkeleton } from '@/app/auth/components/login-pending-skeleton';

export const Route = createFileRoute('/auth')({
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
  // On a cold load of any auth page, THIS layout route is pending while its
  // chunk (and its children's) resolve. Without a pendingComponent here the
  // router falls back to the generic dashboard skeleton, which reads nothing
  // like a sign-in form — so show the auth-form-shaped skeleton instead.
  pendingComponent: LoginPendingSkeleton,
});
