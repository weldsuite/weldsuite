/**
 * WeldFlow + WeldConnect (personal tasks) entity events.
 */
export const PROJECTS_ENTITY_EVENTS = {
  analytics_report: ['created', 'updated', 'deleted'],
  analytics_chart: ['created', 'updated', 'deleted'],
  project: ['created', 'updated', 'deleted', 'archived'],
  project_document: ['created', 'updated', 'deleted'],
  project_file: ['created', 'updated', 'deleted'],
  project_goal: ['created', 'updated', 'deleted'],
  project_label: ['created', 'updated', 'deleted'],
  project_member: ['added', 'updated', 'removed'],
  project_message: ['created', 'updated', 'deleted'],
  project_milestone: ['created', 'updated', 'deleted', 'completed'],
  project_pipeline_stage: ['created', 'updated', 'deleted'],
  project_sprint: ['created', 'updated', 'deleted', 'started', 'completed'],
  project_task: ['created', 'updated', 'deleted', 'completed'],
  project_time_entry: ['created', 'updated', 'deleted'],
  project_timesheet: ['created', 'updated', 'deleted', 'approved', 'rejected'],
  project_whiteboard: ['created', 'updated', 'deleted'],
  task: ['created', 'updated', 'deleted', 'completed'],
  task_comment: ['created', 'updated', 'deleted'],
  task_project: ['created', 'updated', 'deleted', 'archived'],
  task_tag: ['created', 'updated', 'deleted'],
  time_entry: ['created', 'updated', 'deleted'],
  personal_task: ['created', 'updated', 'deleted', 'completed'],
} as const;
