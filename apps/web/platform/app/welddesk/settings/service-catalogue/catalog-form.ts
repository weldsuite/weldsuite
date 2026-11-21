/**
 * The service catalogue item editor's form: values <-> the API's input,
 * validation, and the list's ordering. Pure, so it is tested without a DOM.
 */

import {
  DESK_CATALOG_MAX_APPROVAL_STEPS,
  DESK_CATALOG_MAX_FULFILMENT_TASKS,
  type CreateDeskCatalogItemInput,
  type DeskCatalogItem,
} from '@weldsuite/core-api-client/schemas/desk-catalog';

export const CATALOG_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type CatalogPriority = (typeof CATALOG_PRIORITIES)[number];

/** The icons the editor offers (Lucide names). */
export const CATALOG_ICONS = [
  'laptop',
  'monitor',
  'smartphone',
  'key-round',
  'mail',
  'shield',
  'package',
  'user-plus',
  'wifi',
  'printer',
  'headphones',
  'file-text',
] as const;
export type CatalogIcon = (typeof CATALOG_ICONS)[number];

export interface CatalogStepValues {
  id: string;
  name: string;
  approverType: 'member' | 'team_manager';
  /** `member`: the approver's user id. */
  approverId: string;
  /** `team_manager`: the team; empty uses the request's team. */
  departmentId: string;
}

export interface CatalogTaskValues {
  id: string;
  title: string;
  description: string;
  /** A user id; empty gives the task to the request's owner. */
  assigneeId: string;
  /** Digits as typed; empty means no due date. */
  dueInDays: string;
}

export interface CatalogFormValues {
  name: string;
  summary: string;
  description: string;
  category: string;
  icon: string;
  ticketTypeId: string;
  departmentId: string;
  priority: CatalogPriority | '';
  deliveryEstimate: string;
  approvalSteps: CatalogStepValues[];
  fulfilmentTasks: CatalogTaskValues[];
  audienceCompanyIds: string[];
  isActive: boolean;
}

export type CatalogFormError =
  | 'nameRequired'
  | 'typeRequired'
  | 'stepApprover'
  | 'taskTitle'
  | 'tooManySteps'
  | 'tooManyTasks';

export const MAX_STEPS = DESK_CATALOG_MAX_APPROVAL_STEPS;
export const MAX_TASKS = DESK_CATALOG_MAX_FULFILMENT_TASKS;

/** A client-side id for a row that has none yet; the server only needs it unique within the item. */
export function newRowId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export function emptyStep(): CatalogStepValues {
  return { id: newRowId('step'), name: '', approverType: 'member', approverId: '', departmentId: '' };
}

export function emptyTask(): CatalogTaskValues {
  return { id: newRowId('task'), title: '', description: '', assigneeId: '', dueInDays: '' };
}

export function emptyCatalogValues(): CatalogFormValues {
  return {
    name: '',
    summary: '',
    description: '',
    category: '',
    icon: '',
    ticketTypeId: '',
    departmentId: '',
    priority: '',
    deliveryEstimate: '',
    approvalSteps: [],
    fulfilmentTasks: [],
    audienceCompanyIds: [],
    isActive: true,
  };
}

export function itemToValues(item: DeskCatalogItem): CatalogFormValues {
  return {
    name: item.name,
    summary: item.summary ?? '',
    description: item.description ?? '',
    category: item.category ?? '',
    icon: item.icon ?? '',
    ticketTypeId: item.ticketTypeId,
    departmentId: item.departmentId ?? '',
    priority: item.priority ?? '',
    deliveryEstimate: item.deliveryEstimate ?? '',
    approvalSteps: item.approvalSteps.map((step) => ({
      id: step.id,
      name: step.name ?? '',
      approverType: step.approverType,
      approverId: step.approverId ?? '',
      departmentId: step.departmentId ?? '',
    })),
    fulfilmentTasks: item.fulfilmentTasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description ?? '',
      assigneeId: task.assigneeId ?? '',
      dueInDays: typeof task.dueInDays === 'number' ? String(task.dueInDays) : '',
    })),
    audienceCompanyIds: item.audienceCompanyIds,
    isActive: item.isActive,
  };
}

export function validateCatalogValues(values: CatalogFormValues): CatalogFormError | null {
  if (!values.name.trim()) return 'nameRequired';
  if (!values.ticketTypeId) return 'typeRequired';
  if (values.approvalSteps.length > MAX_STEPS) return 'tooManySteps';
  if (values.approvalSteps.some((step) => step.approverType === 'member' && !step.approverId)) return 'stepApprover';
  if (values.fulfilmentTasks.length > MAX_TASKS) return 'tooManyTasks';
  if (values.fulfilmentTasks.some((task) => !task.title.trim())) return 'taskTitle';
  return null;
}

function dueDays(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const days = Math.floor(Number(trimmed));
  return Number.isFinite(days) ? Math.min(Math.max(days, 0), 365) : null;
}

/** The API input for a valid form; empty text clears the column. */
export function valuesToInput(values: CatalogFormValues): CreateDeskCatalogItemInput {
  const text = (value: string) => value.trim() || null;
  return {
    name: values.name.trim(),
    summary: text(values.summary),
    description: text(values.description),
    category: text(values.category),
    icon: text(values.icon),
    ticketTypeId: values.ticketTypeId,
    departmentId: values.departmentId || null,
    priority: values.priority || null,
    deliveryEstimate: text(values.deliveryEstimate),
    approvalSteps: values.approvalSteps.map((step) => ({
      id: step.id,
      name: text(step.name),
      approverType: step.approverType,
      ...(step.approverType === 'member'
        ? { approverId: step.approverId }
        : { departmentId: step.departmentId || null }),
    })),
    fulfilmentTasks: values.fulfilmentTasks.map((task) => ({
      id: task.id,
      title: task.title.trim(),
      description: text(task.description),
      assigneeId: task.assigneeId || null,
      dueInDays: dueDays(task.dueInDays),
    })),
    audienceCompanyIds: values.audienceCompanyIds,
    isActive: values.isActive,
  };
}

/** `list` with the entry at `index` moved by `by` places; the same list when it can't move. */
export function moveEntry<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const target = index + by;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
  const next = [...list];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved as T);
  return next;
}

/**
 * The sort-order changes that move the item at `index` by one place: every
 * item is renumbered 0..n-1 in the new order, and only those whose number
 * changes are returned.
 */
export function reorderPatches(
  items: ReadonlyArray<Pick<DeskCatalogItem, 'id' | 'sortOrder'>>,
  index: number,
  by: -1 | 1,
): Array<{ id: string; sortOrder: number }> {
  return moveEntry(items, index, by)
    .map((item, position) => ({ id: item.id, sortOrder: position, before: item.sortOrder }))
    .filter((entry) => entry.sortOrder !== entry.before)
    .map(({ id, sortOrder }) => ({ id, sortOrder }));
}

/** The categories in use, sorted, for the category suggestions. */
export function categoriesOf(items: ReadonlyArray<Pick<DeskCatalogItem, 'category'>>): string[] {
  return [...new Set(items.map((item) => item.category?.trim()).filter((c): c is string => Boolean(c)))].sort((a, b) =>
    a.localeCompare(b),
  );
}

export interface ApproverNames {
  member: (userId: string) => string | undefined;
  team: (teamId: string) => string | undefined;
}

export interface ApproverLabels {
  managerOf: string;
  requestTeamManager: string;
  unknownMember: string;
}

/** "Alice, manager of IT": who approves an item, in step order. */
export function approverSummary(
  steps: DeskCatalogItem['approvalSteps'],
  names: ApproverNames,
  labels: ApproverLabels,
): string {
  return steps
    .map((step) => {
      if (step.approverType === 'member') return names.member(step.approverId ?? '') ?? labels.unknownMember;
      if (!step.departmentId) return labels.requestTeamManager;
      return labels.managerOf.replace('{team}', names.team(step.departmentId) ?? step.departmentId);
    })
    .join(', ');
}
