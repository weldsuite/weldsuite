import { Link } from '@tanstack/react-router'
import { Progress } from '@weldsuite/ui/components/progress'
import type { PortalProjectSummary } from '@weldsuite/app-api-client/schemas/project-portal'
import { projectStatus } from '@/lib/labels'
import { usePortal } from '@/components/portal-context'
import { Chip, EmptyText } from '@/components/ui-bits'

function ProjectCard({ workspace, project }: Readonly<{ workspace: string; project: PortalProjectSummary }>) {
  const { t, fill, plural, format } = usePortal()
  const c = t.projects.card
  const status = projectStatus(t, project.status)
  const next = project.nextMilestone

  return (
    <li className="relative flex flex-col gap-3.5 rounded-xl border bg-card p-4 transition-colors focus-within:border-ring hover:border-ring sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-[15px] leading-snug font-semibold break-words">
          {/* The whole card is the link: the link's own box is stretched over it. */}
          <Link
            to="/$workspace/projects/$projectId"
            params={{ workspace, projectId: project.id }}
            className="rounded-sm outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
          >
            {project.name}
          </Link>
        </h2>
        <Chip tone={status.tone} dot>
          {status.label}
        </Chip>
      </div>
      {project.description && <p className="line-clamp-2 text-[13px] text-muted-foreground">{project.description}</p>}
      <div>
        <div className="flex items-baseline justify-between text-xs text-muted-foreground">
          <span>{c.progress}</span>
          <span className="font-medium text-foreground">{format.percent(project.progress)}</span>
        </div>
        <Progress
          value={project.progress}
          aria-label={fill(t.project.stats.progressLabel, { percent: Math.round(project.progress) })}
          className="mt-1.5 h-1.5"
        />
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 text-[13px]">
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">{c.nextMilestone}</dt>
          <dd className="font-medium break-words">{next ? `${next.name} · ${format.date(next.dueDate)}` : c.noMilestone}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">{c.goLive}</dt>
          <dd className="font-medium">{project.goLive ? format.date(project.goLive) : c.notPlanned}</dd>
        </div>
        {project.projectManagerName && (
          <div className="col-span-2 min-w-0">
            <dt className="text-xs text-muted-foreground">{c.projectManager}</dt>
            <dd className="font-medium break-words">{project.projectManagerName}</dd>
          </div>
        )}
      </dl>
      {project.waitingForYou > 0 && (
        <div>
          <Chip tone="warn">{plural(c.waiting, project.waitingForYou)}</Chip>
        </div>
      )}
    </li>
  )
}

/** The contact's projects, one card each. */
export function ProjectCards({
  workspace,
  projects,
}: Readonly<{ workspace: string; projects: PortalProjectSummary[] }>) {
  const { t } = usePortal()
  if (projects.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-6 text-center">
        <h2 className="text-[15px] font-semibold">{t.projects.empty.title}</h2>
        <div className="mt-1">
          <EmptyText>{t.projects.empty.body}</EmptyText>
        </div>
      </div>
    )
  }
  return (
    <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {projects.map((project) => (
        <ProjectCard key={project.id} workspace={workspace} project={project} />
      ))}
    </ul>
  )
}
