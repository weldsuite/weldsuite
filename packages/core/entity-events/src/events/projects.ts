/**
 * WeldFlow project and personal/my-task entity events.
 *
 * Project control (docs: weldflow-project-control.md) and delivery
 * (weldflow-delivery-and-portfolio.md) add the registers, approvals, schedule,
 * reporting, closing and portfolio types below. Finance figures are not
 * published as events (FLOW-019). Beyond the design's tables, so no slice has
 * to touch this shared catalogue: `project_scope`, `resource_request`,
 * `flow_member_profile` and `flow_workspace_settings` (mutations the design
 * lists no entity for), `flow_approval` `cancelled` (rows cleared when a
 * subject is withdrawn or re-routed), `project_status_report` `updated` and
 * `deleted` (drafts are edited and discarded), and `project_task`
 * `rescheduled` (project-scoped tasks publish as `project_task`, not `task`).
 */
export const PROJECTS_ENTITY_EVENTS = {
  analytics_report: ['created', 'updated', 'deleted'],
  analytics_chart: ['created', 'updated', 'deleted'],
  flow_approval: ['requested', 'decided', 'delegated', 'overdue', 'cancelled'],
  flow_member_profile: ['updated'],
  flow_workspace_settings: ['updated'],
  project: ['created', 'updated', 'deleted', 'archived', 'closed'],
  project_baseline: ['created'],
  project_benefit: ['created', 'updated', 'deleted', 'realised'],
  project_change_request: ['created', 'updated', 'deleted', 'submitted', 'approved', 'rejected'],
  project_control_link: ['created', 'deleted'],
  project_decision: ['created', 'updated', 'deleted', 'decided', 'superseded'],
  project_deliverable: ['created', 'updated', 'deleted', 'accepted'],
  project_document: ['created', 'updated', 'deleted'],
  project_file: ['created', 'updated', 'deleted'],
  project_goal: ['created', 'updated', 'deleted'],
  project_label: ['created', 'updated', 'deleted'],
  project_lesson: ['created', 'updated', 'deleted', 'published'],
  project_member: ['added', 'updated', 'removed'],
  project_message: ['created', 'updated', 'deleted'],
  project_milestone: ['created', 'updated', 'deleted', 'completed'],
  project_phase: ['created', 'updated', 'deleted', 'gate_requested', 'passed', 'rejected'],
  project_pipeline_stage: ['created', 'updated', 'deleted'],
  project_raid_item: ['created', 'updated', 'deleted', 'escalated', 'converted', 'closed'],
  project_request: ['created', 'updated', 'deleted', 'submitted', 'approved', 'rejected', 'converted'],
  project_scope: ['created', 'updated'],
  project_sprint: ['created', 'updated', 'deleted', 'started', 'completed'],
  project_stakeholder: ['created', 'updated', 'deleted'],
  project_status_report: ['created', 'updated', 'deleted', 'published'],
  project_task: ['created', 'updated', 'deleted', 'completed', 'rescheduled'],
  project_template: ['created', 'updated', 'deleted', 'instantiated'],
  project_time_entry: ['created', 'updated', 'deleted'],
  project_timesheet: ['created', 'updated', 'deleted', 'approved', 'rejected'],
  project_whiteboard: ['created', 'updated', 'deleted'],
  resource_booking: ['created', 'updated', 'deleted'],
  resource_request: ['created', 'updated', 'deleted'],
  task: ['created', 'updated', 'deleted', 'completed', 'rescheduled'],
  task_comment: ['created', 'updated', 'deleted'],
  task_dependency: ['created', 'updated', 'deleted'],
  task_project: ['created', 'updated', 'deleted', 'archived'],
  task_tag: ['created', 'updated', 'deleted'],
  time_entry: ['created', 'updated', 'deleted'],
  personal_task: ['created', 'updated', 'deleted', 'completed'],
} as const;
