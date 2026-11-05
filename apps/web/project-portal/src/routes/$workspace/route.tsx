import { Link, Outlet, createFileRoute, notFound } from '@tanstack/react-router'
import { buttonVariants } from '@weldsuite/ui/components/button'
import { MessageScreen } from '@/components/message-screen'
import { usePortal } from '@/components/portal-context'
import { PortalShell } from '@/components/portal-shell'
import { getAccount } from '@/lib/portal'
import { parseWorkspaceSlug } from '@/lib/slug'

/**
 * Everything under `/<workspace>`: the header and who is signed in. A
 * workspace is named by a slug (lowercase letters, digits, hyphens); anything
 * else is a 404 without a call to flow-api.
 */
export const Route = createFileRoute('/$workspace')({
  beforeLoad: ({ params }) => {
    if (!parseWorkspaceSlug(params.workspace)) throw notFound()
  },
  loader: ({ params }) => getAccount({ data: { workspace: params.workspace } }),
  // Signing in, out and an expired session reload the page or invalidate this.
  staleTime: 60_000,
  notFoundComponent: WorkspaceNotFound,
  component: WorkspaceLayout,
})

function WorkspaceLayout() {
  const { workspace } = Route.useParams()
  const account = Route.useLoaderData()
  return (
    <PortalShell workspace={workspace} account={account}>
      <Outlet />
    </PortalShell>
  )
}

/** A page under the workspace that does not exist; the layout's header stays around it. */
function WorkspaceNotFound() {
  const { workspace } = Route.useParams()
  const { t } = usePortal()
  return (
    <MessageScreen title={t.notFound.title} body={t.notFound.body}>
      <Link to="/$workspace/projects" params={{ workspace }} className={buttonVariants({ variant: 'outline' })}>
        {t.notFound.toProjects}
      </Link>
    </MessageScreen>
  )
}
