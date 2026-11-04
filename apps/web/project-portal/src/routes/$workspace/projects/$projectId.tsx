import { Link, createFileRoute, getRouteApi } from '@tanstack/react-router'
import { buttonVariants } from '@weldsuite/ui/components/button'
import { MessageScreen } from '@/components/message-screen'
import { usePortal } from '@/components/portal-context'
import { ProjectView } from '@/components/project-view'
import { getProjectPage } from '@/lib/portal'

const workspaceRoute = getRouteApi('/$workspace')

/**
 * `/<workspace>/projects/<id>`: one project, as far as the team shares it.
 * A project the contact may not see is a 404, exactly like one that does not
 * exist.
 */
export const Route = createFileRoute('/$workspace/projects/$projectId')({
  loader: ({ params }) => getProjectPage({ data: { workspace: params.workspace, projectId: params.projectId } }),
  head: ({ loaderData }) => ({ meta: loaderData ? [{ title: loaderData.project.name }] : [] }),
  notFoundComponent: ProjectNotFound,
  component: ProjectPage,
})

function ProjectPage() {
  const { workspace } = Route.useParams()
  const data = Route.useLoaderData()
  const account = workspaceRoute.useLoaderData()
  // `key`: the page keeps local state (answers, thread, lists), which belongs to one project.
  return (
    <ProjectView
      key={data.project.id}
      workspace={workspace}
      workspaceName={account?.workspace.name ?? workspace}
      data={data}
    />
  )
}

function ProjectNotFound() {
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
