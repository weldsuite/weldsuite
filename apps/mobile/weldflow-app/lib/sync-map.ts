/**
 * Mobile EntitySyncMap for weldflow-app — prefixes lockstep with `qk` in
 * hooks/use-weldflow.ts.
 */

import { inv, type EntitySyncMap } from '@weldsuite/realtime/react';

const ROOT = ['weldflow'] as const;
const projects = [...ROOT, 'projects'] as const;
const project = [...ROOT, 'project'] as const;
const projectTasks = [...ROOT, 'project-tasks'] as const;
const task = [...ROOT, 'task'] as const;
const myTasks = [...ROOT, 'my-tasks'] as const;
const projectMembers = [...ROOT, 'project-members'] as const;
const labels = [...ROOT, 'labels'] as const;

/**
 * Hub topics the WeldFlow mobile shell caches today.
 * Catalog leftovers (whiteboard/document/sprint/…) invalidate the same roots
 * so list screens stay fresh when those land on mobile later.
 */
export const weldflowSyncMap: EntitySyncMap = {
  project: inv(projects, project),
  project_task: inv(projects, projectTasks, task, myTasks),
  project_member: inv(projectMembers, project),
  project_label: inv(labels),
  project_milestone: inv(projects, project),
  project_sprint: inv(projects, project),
  project_goal: inv(projects, project),
  project_document: inv(projects, project),
  project_whiteboard: inv(projects, project),
  project_file: inv(projects, project),
  project_time_entry: inv(projects, project, myTasks),
  project_timesheet: inv(projects, project),
  // Personal / alias topics that may appear on the wire.
  task: inv(task, myTasks, projectTasks),
  personal_task: inv(myTasks),
};
