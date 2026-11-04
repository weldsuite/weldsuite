import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { ProjectCards } from '@/components/project-cards'
import { usePortal } from '@/components/portal-context'
import { getProjects } from '@/lib/portal'

const workspaceRoute = getRouteApi('/$workspace')

/** `/<workspace>/projects`: the projects the team shares with the signed-in contact. */
export const Route = createFileRoute('/$workspace/projects/')({
  loader: ({ params }) => getProjects({ data: { workspace: params.workspace } }),
  component: ProjectsPage,
})

function ProjectsPage() {
  const { workspace } = Route.useParams()
  const projects = Route.useLoaderData()
  const account = workspaceRoute.useLoaderData()
  const { t, fill } = usePortal()
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold">{t.projects.title}</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {fill(t.projects.subtitle, { workspace: account?.workspace.name ?? workspace })}
        </p>
      </div>
      <ProjectCards workspace={workspace} projects={projects} />
    </div>
  )
}
