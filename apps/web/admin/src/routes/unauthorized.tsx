import { createFileRoute } from '@tanstack/react-router';
import { AdminShell } from '@/components/shell/admin-shell';
import { getUnauthorizedPage } from '@/app/unauthorized/fn';
import { UnauthorizedPage } from '@/app/unauthorized/view';

/**
 * Outside the `_admin` layout, so a signed-in visitor who isn't an admin can
 * reach it. An admin sent here (a superadmin-only page) still gets the shell;
 * anyone else gets the page bare, as the Next root layout did.
 */
export const Route = createFileRoute('/unauthorized')({
  loader: () => getUnauthorizedPage(),
  component: UnauthorizedRoute,
});

function UnauthorizedRoute() {
  const { identity } = Route.useRouteContext();
  const page = <UnauthorizedPage {...Route.useLoaderData()} />;
  if (!identity) return <div className="h-screen overflow-auto bg-background">{page}</div>;
  return (
    <AdminShell name={identity.name} email={identity.email} role={identity.role}>
      {page}
    </AdminShell>
  );
}
