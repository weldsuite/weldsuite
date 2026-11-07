/**
 * How a change request's status and an approver's decision read on a list row
 * and in the panel: the shared WeldFlow pill, on the RAID tones.
 */

import type { ChangeRequestStatusValue, ReviewApprover } from '@weldsuite/app-api-client/domains/flow-approvals';
import { ListPill } from '@/app/weldflow/components/list-cells';
import { useI18n } from '@/lib/i18n/provider';
import { TONE_PILL } from '../../../raid/_lib/styles';

type ToneName = keyof typeof TONE_PILL;

/** The statuses, in the order of a change's life: the filter offers them so. */
export const CHANGE_STATUSES: readonly ChangeRequestStatusValue[] = [
  'draft',
  'assessing',
  'awaiting_approval',
  'approved',
  'rejected',
  'implemented',
  'withdrawn',
];

const STATUS_TONE: Readonly<Record<ChangeRequestStatusValue, ToneName>> = {
  draft: 'neutral',
  assessing: 'blue',
  awaiting_approval: 'orange',
  approved: 'green',
  rejected: 'red',
  implemented: 'green',
  withdrawn: 'neutral',
};

const DECISION_TONE: Readonly<Record<ReviewApprover['decision'], ToneName>> = {
  pending: 'neutral',
  approved: 'green',
  approved_with_conditions: 'green',
  rejected: 'red',
  info_requested: 'orange',
};

/** The status of a change request, translated, on its tone. */
export function ChangeStatusPill({ status }: Readonly<{ status: ChangeRequestStatusValue }>) {
  const { t } = useI18n();
  return <ListPill className={TONE_PILL[STATUS_TONE[status]]}>{t.flowApprovals.changes.status[status]}</ListPill>;
}

/** What an approver answered (or still has to), translated, on its tone. */
export function DecisionPill({ decision }: Readonly<{ decision: ReviewApprover['decision'] }>) {
  const { t } = useI18n();
  return <ListPill className={TONE_PILL[DECISION_TONE[decision]]}>{t.flowApprovals.reviews.decision[decision]}</ListPill>;
}

/** The route a change takes to its approvers, translated. */
export function useRouteLabel(): (route: 'manager' | 'board') => string {
  const { t } = useI18n();
  const copy = t.flowApprovals.changes.detail;
  return (route) => (route === 'board' ? copy.routeBoard : copy.routeManager);
}
