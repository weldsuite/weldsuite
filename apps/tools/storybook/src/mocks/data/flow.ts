/**
 * Deterministic mock data for the WeldFlow (projects/tasks) flows.
 *
 * Task shapes are compatible with `@weldsuite/ui`'s KanbanProvider, which
 * requires `{ id, name, column }` plus arbitrary extra fields. We carry the
 * extra task metadata (assignee, priority, project) as those extra fields.
 *
 * As with the CRM mocks, types are local on purpose and faker is seeded so the
 * board looks identical on every reload.
 */
import { faker } from '@faker-js/faker';
import type { KanbanColumnProps, KanbanItemProps } from '@weldsuite/ui/components/kanban';

faker.seed(424242);

export type ProjectStatus = 'planning' | 'active' | 'on_hold' | 'done';

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  progress: number;
  taskCount: number;
  members: string[];
  dueDate: string;
  lead: string;
}

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

/** A kanban-compatible task card. `column` is the stage id. */
export interface Task extends KanbanItemProps {
  assignee: string;
  assigneeInitials: string;
  priority: TaskPriority;
  projectId: string;
}

/** Kanban columns (task stages), in board order. */
export const taskStages: KanbanColumnProps[] = [
  { id: 'backlog', name: 'Backlog' },
  { id: 'in_progress', name: 'In Progress' },
  { id: 'review', name: 'Review' },
  { id: 'done', name: 'Done' },
];

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  planning: 'Planning',
  active: 'Active',
  on_hold: 'On hold',
  done: 'Done',
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

function makeMembers(n: number): string[] {
  return Array.from({ length: n }, () => faker.person.firstName());
}

export const projects: Project[] = [
  {
    id: 'prj_website',
    name: 'Website redesign',
    status: 'active',
    progress: 62,
    taskCount: 8,
    members: makeMembers(4),
    dueDate: faker.date.soon({ days: 21 }).toISOString(),
    lead: 'Priya N.',
  },
  {
    id: 'prj_launch',
    name: 'Q3 product launch',
    status: 'planning',
    progress: 18,
    taskCount: 12,
    members: makeMembers(5),
    dueDate: faker.date.soon({ days: 60 }).toISOString(),
    lead: 'Sam O.',
  },
  {
    id: 'prj_migration',
    name: 'Billing migration',
    status: 'on_hold',
    progress: 40,
    taskCount: 6,
    members: makeMembers(3),
    dueDate: faker.date.soon({ days: 45 }).toISOString(),
    lead: 'Lena R.',
  },
  {
    id: 'prj_onboarding',
    name: 'Customer onboarding revamp',
    status: 'done',
    progress: 100,
    taskCount: 9,
    members: makeMembers(3),
    dueDate: faker.date.recent({ days: 10 }).toISOString(),
    lead: 'Priya N.',
  },
];

function makeTask(name: string, column: string, priority: TaskPriority): Task {
  const assignee = faker.person.firstName();
  return {
    id: `tsk_${faker.string.alphanumeric(8)}`,
    name,
    column,
    assignee,
    assigneeInitials: assignee.slice(0, 2).toUpperCase(),
    priority,
    projectId: 'prj_website',
  };
}

/** Task board for the "Website redesign" project. */
export const websiteTasks: Task[] = [
  makeTask('Audit current sitemap', 'done', 'medium'),
  makeTask('Define content model', 'done', 'high'),
  makeTask('Wireframe homepage', 'review', 'high'),
  makeTask('Design system tokens', 'in_progress', 'medium'),
  makeTask('Build navigation component', 'in_progress', 'high'),
  makeTask('Write hero copy', 'backlog', 'low'),
  makeTask('SEO metadata pass', 'backlog', 'medium'),
  makeTask('Accessibility review', 'backlog', 'urgent'),
];
