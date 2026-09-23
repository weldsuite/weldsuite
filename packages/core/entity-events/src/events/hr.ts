/**
 * WeldHR entity events.
 *
 * Every catalog topic is subscribable by any workspace member on the
 * WorkspaceHub, so WeldHR publishers put ids and status on the payload only —
 * never names, notes, scores or anything from the sensitive block. Consumers
 * that need the record fetch it through the permission-checked API.
 */
export const HR_ENTITY_EVENTS = {
  hr_employee: ['created', 'updated', 'deleted', 'onboarded', 'offboarded'],
  hr_client_assignment: ['created', 'updated', 'deleted'],
  hr_checklist: ['created', 'updated', 'deleted', 'completed'],
  hr_attendance: ['created', 'updated', 'deleted', 'approved'],
  hr_leave_request: ['created', 'updated', 'deleted', 'approved', 'rejected'],
  hr_coaching_log: ['created', 'updated', 'deleted', 'acknowledged'],
  hr_evaluation: ['created', 'updated', 'deleted', 'submitted', 'acknowledged'],
  hr_kpi_value: ['created', 'updated', 'deleted'],
  hr_milestone: ['created', 'updated', 'deleted', 'achieved'],
} as const;
