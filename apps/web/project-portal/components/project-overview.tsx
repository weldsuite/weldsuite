import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, Eye } from 'lucide-react'
import { Progress } from '@weldsuite/ui/components/progress'
import { cn } from '@weldsuite/ui/lib/utils'
import type { PortalApproval, PortalProject } from '@weldsuite/app-api-client/schemas/project-portal'
import { projectStatus } from '@/lib/labels'
import { usePortal } from '@/components/portal-context'
import { Chip } from '@/components/ui-bits'

/** The top of the project page: back link, name, who delivers it, and what the contact is looking at. */
export function ProjectHeader({
  workspace,
  workspaceName,
  project,
}: Readonly<{ workspace: string; workspaceName: string; project: PortalProject }>) {
  const { t, fill } = usePortal()
  const status = projectStatus(t, project.status)
  const delivered = [
    fill(t.project.deliveredBy, { workspace: workspaceName }),
    ...(project.projectManagerName ? [fill(t.project.projectManager, { name: project.projectManagerName })] : []),
  ].join(' · ')

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-1 basis-80">
        <Link
          to="/$workspace/projects"
          params={{ workspace }}
          className="inline-flex items-center gap-1 rounded-sm text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          {t.project.back}
        </Link>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-2xl font-semibold break-words">{project.name}</h1>
          <Chip tone={status.tone} dot>
            {status.label}
          </Chip>
        </div>
        <p className="mt-1 text-[13px] text-muted-foreground">{delivered}</p>
      </div>
      <p className="inline-flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
        <Eye className="size-3.5 shrink-0" aria-hidden="true" />
        {t.project.sharedNote}
      </p>
    </div>
  )
}

function Tile({
  label,
  value,
  note,
  warn = false,
  children,
}: Readonly<{ label: string; value: string; note?: string | null; warn?: boolean; children?: ReactNode }>) {
  return (
    <div
      className={cn(
        'rounded-xl border p-3.5 sm:px-4',
        warn ? 'border-amber-500/30 bg-amber-500/10' : 'bg-card',
      )}
    >
      <div className={cn('text-xs', warn ? 'text-amber-800 dark:text-amber-300' : 'text-muted-foreground')}>{label}</div>
      <div className="mt-1 text-xl leading-snug font-semibold break-words">{value}</div>
      {children}
      {note && (
        <div className={cn('mt-0.5 text-xs', warn ? 'text-amber-800 dark:text-amber-300' : 'text-muted-foreground')}>
          {note}
        </div>
      )}
    </div>
  )
}

/** Progress, the next milestone, go-live and what waits for the contact. */
export function StatTiles({
  project,
  approvals,
}: Readonly<{ project: PortalProject; approvals: PortalApproval[] }>) {
  const { t, fill, plural, format } = usePortal()
  const s = t.project.stats
  const next = project.nextMilestone
  const waiting = approvals.length
  const oldest = approvals.reduce<string | null>(
    (min, approval) => (min === null || approval.requestedAt < min ? approval.requestedAt : min),
    null,
  )

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile label={s.progress} value={format.percent(project.progress)}>
        <Progress
          value={project.progress}
          aria-label={fill(s.progressLabel, { percent: Math.round(project.progress) })}
          className="mt-2 h-1.5"
        />
      </Tile>
      <Tile
        label={s.nextMilestone}
        value={next ? `${next.name} · ${format.date(next.dueDate)}` : s.noMilestone}
        note={next?.description}
      />
      <Tile label={s.goLive} value={project.goLive ? format.date(project.goLive) : s.notPlanned} />
      <Tile
        label={s.waiting}
        value={waiting > 0 ? plural(s.waitingCount, waiting) : s.nothingWaiting}
        note={waiting > 0 && oldest ? fill(s.oldestSent, { date: format.date(oldest) }) : s.upToDate}
        warn={waiting > 0}
      />
    </div>
  )
}
