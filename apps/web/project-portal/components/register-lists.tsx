import { CircleCheck, Flag } from 'lucide-react'
import type {
  PortalChangeRequest,
  PortalDeliverable,
  PortalMilestone,
} from '@weldsuite/app-api-client/schemas/project-portal'
import { changeStatus, deliverableStatus } from '@/lib/labels'
import { usePortal } from '@/components/portal-context'
import { Chip, EmptyText, Section } from '@/components/ui-bits'

/**
 * The compact lists under the stat tiles: what the team shared of the
 * milestones, deliverables and change requests. Read only; what needs an
 * answer is in "Waiting for you".
 */

export function Milestones({
  milestones,
  nextId,
  className,
}: Readonly<{ milestones: PortalMilestone[]; nextId: string | null; className?: string }>) {
  const { t, fill, format } = usePortal()
  const m = t.project.milestones
  return (
    <Section title={m.title} className={className}>
      {milestones.length === 0 ? (
        <EmptyText>{m.empty}</EmptyText>
      ) : (
        <ul className="flex flex-col">
          {milestones.map((milestone) => (
            <li key={milestone.id} className="flex items-start gap-2.5 border-t py-2.5 first:border-t-0 first:pt-0 last:pb-0">
              {milestone.completed ? (
                <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Flag
                  aria-hidden="true"
                  className={
                    milestone.id === nextId
                      ? 'mt-0.5 size-4 shrink-0 text-foreground'
                      : 'mt-0.5 size-4 shrink-0 text-muted-foreground'
                  }
                />
              )}
              <div className="min-w-0 flex-1">
                <p className={milestone.id === nextId ? 'text-[13px] font-semibold' : 'text-[13px] font-medium'}>
                  {milestone.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {milestone.completed ? `${m.completed} · ${format.date(milestone.dueDate)}` : fill(m.due, { date: format.date(milestone.dueDate) })}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

export function Deliverables({
  deliverables,
  className,
}: Readonly<{ deliverables: PortalDeliverable[]; className?: string }>) {
  const { t, fill, format } = usePortal()
  const d = t.project.deliverables
  return (
    <Section title={d.title} className={className}>
      {deliverables.length === 0 ? (
        <EmptyText>{d.empty}</EmptyText>
      ) : (
        <ul className="flex flex-col">
          {deliverables.map((deliverable) => {
            const status = deliverableStatus(t, deliverable.status)
            const when = deliverable.acceptedAt
              ? fill(d.accepted, { date: format.date(deliverable.acceptedAt) })
              : deliverable.plannedEnd
                ? fill(d.planned, { date: format.date(deliverable.plannedEnd) })
                : ''
            return (
              <li
                key={deliverable.id}
                className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 border-t py-2.5 first:border-t-0 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">
                    {deliverable.code} · {deliverable.title}
                  </p>
                  {when && <p className="text-xs text-muted-foreground">{when}</p>}
                </div>
                <Chip tone={status.tone}>{status.label}</Chip>
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}

export function ChangeRequests({
  changeRequests,
  className,
}: Readonly<{ changeRequests: PortalChangeRequest[]; className?: string }>) {
  const { t, fill, format, plural } = usePortal()
  const c = t.project.changes
  return (
    <Section title={c.title} className={className}>
      {changeRequests.length === 0 ? (
        <EmptyText>{c.empty}</EmptyText>
      ) : (
        <ul className="flex flex-col">
          {changeRequests.map((change) => {
            const status = changeStatus(t, change.status)
            const cost = change.costDelta !== null ? format.money(change.costDelta, change.currency) : ''
            const time =
              change.scheduleDeltaDays !== null
                ? plural(t.project.waiting.impact.days, change.scheduleDeltaDays, {
                    count: format.signed(change.scheduleDeltaDays),
                  })
                : ''
            const details = [
              cost && `${t.project.waiting.impact.cost}: ${cost}`,
              time && `${t.project.waiting.impact.time}: ${time}`,
              change.decidedAt && fill(c.decided, { date: format.date(change.decidedAt) }),
            ].filter(Boolean)
            return (
              <li
                key={change.id}
                className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 border-t py-2.5 first:border-t-0 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">
                    {change.code} · {change.title}
                  </p>
                  {details.length > 0 && <p className="text-xs text-muted-foreground">{details.join(' · ')}</p>}
                </div>
                <Chip tone={status.tone}>{status.label}</Chip>
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}
