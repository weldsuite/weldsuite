/**
 * Timeline sentences for the internal service request events: a step went to
 * its approver, was approved or rejected, and the item's tasks were created.
 * Kept out of messages-timeline.tsx, which only calls in here.
 */

import { getTranslations } from '@/lib/i18n';
import type { DeskEventType, DeskMessage } from '@/hooks/queries/use-desk-queries';

const REQUEST_EVENTS = new Set<DeskEventType>(['approval_requested', 'approval_approved', 'approval_rejected', 'fulfilment_started']);

/** Service request events only the team sees. */
export function isServiceRequestEvent(message: DeskMessage): boolean {
  const eventType = message.metadata?.eventType;
  return eventType !== undefined && REQUEST_EVENTS.has(eventType);
}

/** "Ada approved Budget approval", or null for any other event. */
export function serviceRequestEventSentence(
  message: DeskMessage,
  actor: string,
  memberName: (userId: string) => string | null,
): string | null {
  const t = getTranslations('deskCatalog').timeline;
  const meta = message.metadata ?? {};
  const stepIndex = typeof meta.stepIndex === 'number' ? meta.stepIndex : 0;
  const stepName = typeof meta.stepName === 'string' && meta.stepName ? meta.stepName : t.step.replace('{number}', String(stepIndex + 1));
  const approverId = typeof meta.approverId === 'string' ? meta.approverId : null;
  const comment = typeof meta.comment === 'string' && meta.comment ? meta.comment : null;
  const withComment = (sentence: string) => (comment ? t.withComment.replace('{sentence}', sentence).replace('{comment}', comment) : sentence);
  switch (meta.eventType) {
    case 'approval_requested':
      return approverId
        ? t.approvalRequested.replace('{approver}', memberName(approverId) ?? approverId).replace('{step}', stepName)
        : t.approvalRequestedNobody.replace('{step}', stepName);
    case 'approval_approved':
      return withComment(t.approvalApproved.replace('{actor}', actor).replace('{step}', stepName));
    case 'approval_rejected':
      return withComment(t.approvalRejected.replace('{actor}', actor).replace('{step}', stepName));
    case 'fulfilment_started': {
      const count = Array.isArray(meta.taskIds) ? meta.taskIds.length : 0;
      return count === 1 ? t.fulfilmentStartedOne : t.fulfilmentStartedOther.replace('{count}', String(count));
    }
    default:
      return null;
  }
}
