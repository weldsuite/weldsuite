import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { AdminShell } from '@/components/shell/admin-shell';

/**
 * Every console page sits under this layout: an admin identity or the
 * `/unauthorized` screen, and the shell around the page. Each page's loader
 * and every action check the identity again on the server.
 */
export const Route = createFileRoute('/_admin')({
  beforeLoad: ({ context }) => {
    if (!context.identity) throw redirect({ href: '/unauthorized' });
    return { identity: context.identity };
  },
  component: AdminLayout,
});

function AdminLayout() {
  const { identity } = Route.useRouteContext();
  return (
    <AdminShell name={identity.name} email={identity.email} role={identity.role}>
      <Outlet />
    </AdminShell>
  );
}
