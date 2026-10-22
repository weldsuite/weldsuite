/**
 * Grouping and filtering of the task list.
 */

import { isOverdue, isThisWeek, isToday, isTomorrow, parseDate } from './dates';
import type { TaskStatus } from './crm';

export interface GroupableTask {
  title: string;
  completed: boolean;
  status: TaskStatus;
  dueDate?: string;
  linkedCompany?: { name: string };
}

export type TaskSectionKey = 'overdue' | 'today' | 'tomorrow' | 'thisWeek' | 'later' | 'noDate' | 'completed';

export const TASK_SECTION_ORDER: readonly TaskSectionKey[] = [
  'overdue',
  'today',
  'tomorrow',
  'thisWeek',
  'later',
  'noDate',
  'completed',
];

/** Does the task match the search text (title or company) and the status filter (null = all)? */
export function matchesTaskFilters(task: GroupableTask, searchTerm: string, status: TaskStatus | null): boolean {
  const term = searchTerm.trim().toLowerCase();
  const matchesSearch =
    term.length === 0 ||
    task.title.toLowerCase().includes(term) ||
    (task.linkedCompany?.name.toLowerCase().includes(term) ?? false);
  return matchesSearch && (status === null || task.status === status);
}

/** The section an open task belongs to by due date; finished tasks go to `completed`. */
export function sectionFor(task: GroupableTask, now: Date = new Date()): TaskSectionKey {
  if (task.completed) return 'completed';
  const due = parseDate(task.dueDate);
  if (!due) return 'noDate';
  if (isToday(due, now)) return 'today';
  if (isOverdue(due, now)) return 'overdue';
  if (isTomorrow(due, now)) return 'tomorrow';
  if (isThisWeek(due, now)) return 'thisWeek';
  return 'later';
}

/** Tasks bucketed into sections, keeping the input order within each. */
export function groupTasks<T extends GroupableTask>(tasks: readonly T[], now: Date = new Date()): Record<TaskSectionKey, T[]> {
  const groups: Record<TaskSectionKey, T[]> = {
    overdue: [],
    today: [],
    tomorrow: [],
    thisWeek: [],
    later: [],
    noDate: [],
    completed: [],
  };
  for (const task of tasks) groups[sectionFor(task, now)].push(task);
  return groups;
}
