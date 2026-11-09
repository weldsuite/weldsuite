/**
 * The timeline line for an `escalated` event: one of the team's escalation
 * rules fired (`@weldsuite/db/lib/desk-escalation`). Internal, like an SLA
 * warning.
 */

import { getTranslations } from '@/lib/i18n';

type Reason = 'unassigned' | 'no_response' | 'sla_breach';

/** `metadata` of an `escalated` event; `nameOf` resolves a teammate's user id to a name. */
export function escalationSentence(
  metadata: Record<string, unknown> | null | undefined,
  nameOf: (userId: string) => string | null | undefined,
): string {
  const t = getTranslations('helpdesk').escalation.timeline;
  const condition = metadata?.condition;
  const reason = t.reasons[(condition as Reason) in t.reasons ? (condition as Reason) : 'unassigned'];
  const assigneeId = typeof metadata?.assigneeId === 'string' ? metadata.assigneeId : null;
  if (assigneeId) return t.toOwner.replace('{target}', nameOf(assigneeId) ?? assigneeId).replace('{reason}', reason);
  if (typeof metadata?.toTeamId === 'string') return t.toNextTeam.replace('{reason}', reason);
  return t.noTarget.replace('{reason}', reason);
}
