/**
 * The words for the statuses flow-api sends as plain strings. A status the
 * portal has no word for (a custom project status, say) is shown as it is.
 */
import type { PortalStatusColour } from '@weldsuite/app-api-client/schemas/project-portal'
import type { PortalStrings } from '@/lib/i18n'

/** `On Hold`, `on_hold` and `ON-HOLD` all read the same. */
function key(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '')
}

export type Tone = 'neutral' | 'good' | 'warn' | 'bad'

export function projectStatus(t: PortalStrings, status: string): { label: string; tone: Tone } {
  switch (key(status)) {
    case 'planning':
      return { label: t.status.planning, tone: 'neutral' }
    case 'active':
      return { label: t.status.active, tone: 'good' }
    case 'onhold':
      return { label: t.status.onHold, tone: 'warn' }
    case 'completed':
      return { label: t.status.completed, tone: 'good' }
    case 'closed':
      return { label: t.status.closed, tone: 'neutral' }
    case 'cancelled':
    case 'canceled':
      return { label: t.status.cancelled, tone: 'bad' }
    default:
      return { label: status, tone: 'neutral' }
  }
}

export function deliverableStatus(t: PortalStrings, status: string): { label: string; tone: Tone } {
  switch (key(status)) {
    case 'notstarted':
      return { label: t.deliverableStatus.notStarted, tone: 'neutral' }
    case 'inprogress':
      return { label: t.deliverableStatus.inProgress, tone: 'neutral' }
    case 'accepted':
      return { label: t.deliverableStatus.accepted, tone: 'good' }
    case 'rejected':
      return { label: t.deliverableStatus.rejected, tone: 'bad' }
    default:
      return { label: status, tone: 'neutral' }
  }
}

export function changeStatus(t: PortalStrings, status: string): { label: string; tone: Tone } {
  switch (key(status)) {
    case 'draft':
      return { label: t.changeStatus.draft, tone: 'neutral' }
    case 'assessing':
      return { label: t.changeStatus.assessing, tone: 'neutral' }
    case 'awaitingapproval':
      return { label: t.changeStatus.awaitingApproval, tone: 'warn' }
    case 'approved':
      return { label: t.changeStatus.approved, tone: 'good' }
    case 'implemented':
      return { label: t.changeStatus.implemented, tone: 'good' }
    case 'rejected':
      return { label: t.changeStatus.rejected, tone: 'bad' }
    case 'withdrawn':
      return { label: t.changeStatus.withdrawn, tone: 'neutral' }
    default:
      return { label: status, tone: 'neutral' }
  }
}

/** The label of a status report area (`schedule`, `budget`, ...); an area the portal does not know keeps its key. */
export function reportArea(t: PortalStrings, area: string): string {
  switch (area) {
    case 'schedule':
      return t.rag.areas.schedule
    case 'budget':
      return t.rag.areas.budget
    case 'scope':
      return t.rag.areas.scope
    case 'risk':
      return t.rag.areas.risk
    case 'benefits':
      return t.rag.areas.benefits
    default:
      return area
  }
}

export function reportColour(t: PortalStrings, colour: PortalStatusColour): string {
  return t.rag.states[colour]
}
