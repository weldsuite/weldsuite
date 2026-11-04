/**
 * Project templates: blueprints (design: weldflow-delivery-and-portfolio.md,
 * "Create from a template"; ADR FLOW-021; slice F).
 *
 * A blueprint is a project with its dates as working-day offsets from the
 * start, its people as roles and its ids as local keys. This file holds the
 * three pure halves of that:
 *
 *   - `buildBlueprint`: a project's rows into a blueprint ("Save as template"),
 *   - `blueprintIntegrityError`: the rules a blueprint has to keep after the
 *     shape check (unique keys, every reference resolves, no cycles),
 *   - `planInstantiation`: a blueprint, a start date and a person per role into
 *     every row of the new project ("Create project").
 *
 * No database and no Hono context. flow-api's `/api/project-templates` routes
 * read and write the rows around them, and the Rust flow-domain mirrors them.
 * Every message returned here is sent to the client as it is, so the two
 * backends answer alike.
 */

import type { schema } from '@weldsuite/worker-kit/db';
import type { ProjectSettings } from '@weldsuite/db/schema/project-settings';
import {
  BLUEPRINT_VERSION,
  PROJECT_MANAGER_ROLE,
  SPONSOR_ROLE,
  addWorkingDays,
  blueprintSchema,
  workingDayOffset,
  DEFAULT_WORKING_DAYS,
  type Blueprint,
  type BlueprintMemberRole,
  type BlueprintSummary,
  type InstantiateCopy,
  type InstantiateResult,
} from '@weldsuite/app-api-client/schemas/project-closing';
import { GATE_CRITERION_KEYS } from './gates';
import { nextReviewAt, riskBand, riskScore } from './risk';
import { initialRaidStatus, raidSequence, type RaidKind } from './raid';
import type { NumberSequence } from './task-numbering';

export { BLUEPRINT_VERSION, PROJECT_MANAGER_ROLE, SPONSOR_ROLE };
export type { Blueprint };

type ProjectRow = typeof schema.projects.$inferSelect;
type MemberRow = typeof schema.projectMembers.$inferSelect;
type StageRow = typeof schema.projectPipelineStages.$inferSelect;
type PhaseRow = typeof schema.projectPhases.$inferSelect;
type MilestoneRow = typeof schema.milestones.$inferSelect;
type DeliverableRow = typeof schema.projectDeliverables.$inferSelect;
type TaskRow = typeof schema.tasks.$inferSelect;
type DependencyRow = typeof schema.taskDependencies.$inferSelect;
type RaidRow = typeof schema.projectRaidItems.$inferSelect;

export type NewProjectRow = typeof schema.projects.$inferInsert;
export type NewMemberRow = typeof schema.projectMembers.$inferInsert;
export type NewStageRow = typeof schema.projectPipelineStages.$inferInsert;
export type NewPhaseRow = typeof schema.projectPhases.$inferInsert;
export type NewMilestoneRow = typeof schema.milestones.$inferInsert;
export type NewDeliverableRow = typeof schema.projectDeliverables.$inferInsert;
export type NewTaskRow = typeof schema.tasks.$inferInsert;
export type NewDependencyRow = typeof schema.taskDependencies.$inferInsert;
export type NewRaidRow = typeof schema.projectRaidItems.$inferInsert;
export type NewAssessmentRow = typeof schema.projectRaidAssessments.$inferInsert;
export type NewSequenceRow = typeof schema.taskNumberSequences.$inferInsert;

/** The messages of every refusal a template rule answers with. */
export const TEMPLATE_MESSAGES = {
  unsupportedVersion: 'This template was saved in a format that is not supported',
  cannotSave: 'This project cannot be saved as a template',
  invalidBlueprint: 'The template is no longer valid',
  unknownRole: (role: string) => `The template has no role '${role}'`,
} as const;

// ── Reading a stored blueprint ──────────────────────────────────────────────

export type ReadBlueprintResult = { ok: true; blueprint: Blueprint } | { ok: false; message: string };

/**
 * A stored blueprint, upgraded to the current layout and checked. Older
 * versions are upgraded here when there are any (there is one so far); an
 * unknown version or a blueprint that no longer passes the schema and the
 * integrity rules is refused. Gate criteria saved before they carried local
 * keys (they kept the source project's ids) are turned into manual ones, see
 * {@link upgradeGateCriteria}.
 */
export function readBlueprint(stored: unknown): ReadBlueprintResult {
  const version = typeof stored === 'object' && stored !== null ? (stored as { version?: unknown }).version : undefined;
  if (version !== BLUEPRINT_VERSION) return { ok: false, message: TEMPLATE_MESSAGES.unsupportedVersion };
  const parsed = blueprintSchema.safeParse(stored);
  if (!parsed.success) return { ok: false, message: TEMPLATE_MESSAGES.invalidBlueprint };
  const upgraded = upgradeGateCriteria(parsed.data);
  const broken = blueprintIntegrityError(upgraded);
  if (broken) return { ok: false, message: TEMPLATE_MESSAGES.invalidBlueprint };
  return { ok: true, blueprint: upgraded };
}

// ── Gate criteria in a blueprint ────────────────────────────────────────────
//
// A gate criterion of a project points at rows of that project: a deliverable
// or a decision by id. None of those ids exist in a project made from the
// template, so a blueprint stores them differently:
//
//   - `deliverable_accepted` / `deliverable_tasks_done` keep `params.deliverableKey`
//     (the deliverable's local key) instead of `params.deliverableId`. Creating
//     the project maps the key to the new deliverable's id. When the deliverables
//     are not copied, the criterion becomes a manual one: "Deliverable accepted:
//     <title>".
//   - `decision_decided` becomes the manual criterion "Decision decided": decisions
//     are never copied, so there is nothing for it to resolve to.
//   - A key that is not in the catalogue becomes a manual criterion with the key
//     as its text (nothing could ever evaluate it).
//
// The other criteria (risk band, change requests, spend) have no ids and are kept.

type BlueprintCriterion = Blueprint['phases'][number]['gateCriteria'][number];

const DELIVERABLE_CRITERION_TEXT: Readonly<Record<string, string>> = {
  deliverable_accepted: 'Deliverable accepted',
  deliverable_tasks_done: 'Deliverable tasks done',
};
const DECISION_CRITERION_KEY = 'decision_decided';
const DECISION_CRITERION_TEXT = 'Decision decided';

function isDeliverableCriterion(key: string): boolean {
  return key in DELIVERABLE_CRITERION_TEXT;
}

/** The manual text a deliverable criterion turns into: its name, then the deliverable's title when known. */
function deliverableCriterionText(key: string, title: string | null): string {
  const text = DELIVERABLE_CRITERION_TEXT[key] ?? key;
  return title ? `${text}: ${title}` : text;
}

function deliverableKeyOf(params: Record<string, unknown> | undefined): string | null {
  const value = params?.deliverableKey;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A criterion of a stored blueprint that cannot be kept as it is, as a manual one; the others unchanged. */
function upgradeCriterion(criterion: BlueprintCriterion): BlueprintCriterion {
  if ('manual' in criterion) return criterion;
  if (isDeliverableCriterion(criterion.key)) {
    return deliverableKeyOf(criterion.params) ? criterion : { manual: deliverableCriterionText(criterion.key, null) };
  }
  if (criterion.key === DECISION_CRITERION_KEY) return { manual: DECISION_CRITERION_TEXT };
  if (!(GATE_CRITERION_KEYS as readonly string[]).includes(criterion.key)) return { manual: criterion.key };
  return criterion;
}

function upgradeGateCriteria(blueprint: Blueprint): Blueprint {
  return {
    ...blueprint,
    phases: blueprint.phases.map((phase) => ({ ...phase, gateCriteria: phase.gateCriteria.map(upgradeCriterion) })),
  };
}

// ── Integrity ───────────────────────────────────────────────────────────────

function duplicate(keys: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}

/**
 * The rules a blueprint keeps beyond its shape: keys are unique within their
 * list, every reference (parent, milestone, deliverable, role, dependency end)
 * names something the blueprint has, a task is not its own ancestor and the
 * dependencies do not run in a circle. Returns the 400 message, or null.
 */
export function blueprintIntegrityError(blueprint: Blueprint): string | null {
  const keys = {
    roles: new Set(blueprint.roles.map((entry) => entry.key)),
    milestones: new Set(blueprint.milestones.map((entry) => entry.key)),
    deliverables: new Set(blueprint.deliverables.map((entry) => entry.key)),
    tasks: new Set(blueprint.tasks.map((entry) => entry.key)),
  };
  return (
    duplicateKeyError(blueprint) ??
    ownerRoleError(blueprint, keys.roles) ??
    taskReferenceError(blueprint, keys) ??
    gateCriteriaError(blueprint, keys.deliverables) ??
    ancestorError(blueprint) ??
    dependencyError(blueprint, keys.tasks)
  );
}

function duplicateKeyError(blueprint: Blueprint): string | null {
  const lists: Array<[string, readonly string[]]> = [
    ['role', blueprint.roles.map((entry) => entry.key)],
    ['stage', blueprint.stages.map((entry) => entry.key)],
    ['phase', blueprint.phases.map((entry) => entry.key)],
    ['milestone', blueprint.milestones.map((entry) => entry.key)],
    ['deliverable', blueprint.deliverables.map((entry) => entry.key)],
    ['task', blueprint.tasks.map((entry) => entry.key)],
  ];
  for (const [label, keys] of lists) {
    const repeated = duplicate(keys);
    if (repeated !== null) return `Duplicate ${label} key: ${repeated}`;
  }
  return null;
}

/** The refusal for an owner role (milestone, deliverable, register item, change board) the blueprint does not have. */
function ownerRoleError(blueprint: Blueprint, roles: ReadonlySet<string>): string | null {
  const unknownRole = (role: string | null | undefined) => (role && !roles.has(role) ? role : null);
  for (const milestone of blueprint.milestones) {
    const bad = unknownRole(milestone.ownerRole);
    if (bad) return `Milestone ${milestone.key} refers to an unknown role: ${bad}`;
  }
  for (const deliverable of blueprint.deliverables) {
    const bad = unknownRole(deliverable.ownerRole);
    if (bad) return `Deliverable ${deliverable.key} refers to an unknown role: ${bad}`;
  }
  for (const item of blueprint.raid) {
    const bad = unknownRole(item.ownerRole);
    if (bad) return `A register item refers to an unknown role: ${bad}`;
  }
  for (const role of blueprint.settings.changeControl?.boardRoles ?? []) {
    if (!roles.has(role)) return `The change board refers to an unknown role: ${role}`;
  }
  return null;
}

function taskReferenceError(
  blueprint: Blueprint,
  keys: { roles: ReadonlySet<string>; milestones: ReadonlySet<string>; deliverables: ReadonlySet<string>; tasks: ReadonlySet<string> },
): string | null {
  for (const task of blueprint.tasks) {
    if (task.parentKey && !keys.tasks.has(task.parentKey)) return `Task ${task.key} refers to an unknown parent: ${task.parentKey}`;
    if (task.milestoneKey && !keys.milestones.has(task.milestoneKey)) {
      return `Task ${task.key} refers to an unknown milestone: ${task.milestoneKey}`;
    }
    if (task.deliverableKey && !keys.deliverables.has(task.deliverableKey)) {
      return `Task ${task.key} refers to an unknown deliverable: ${task.deliverableKey}`;
    }
    for (const role of task.assigneeRoles) if (!keys.roles.has(role)) return `Task ${task.key} refers to an unknown role: ${role}`;
  }
  return null;
}

/** A gate criterion is a catalogue key the blueprint can carry, and refers to a deliverable by one of its keys. */
function gateCriteriaError(blueprint: Blueprint, deliverables: ReadonlySet<string>): string | null {
  for (const phase of blueprint.phases) {
    for (const criterion of phase.gateCriteria) {
      if ('manual' in criterion) continue;
      if (!(GATE_CRITERION_KEYS as readonly string[]).includes(criterion.key)) {
        return `Phase ${phase.key} has an unknown gate criterion: ${criterion.key}`;
      }
      if (criterion.key === DECISION_CRITERION_KEY) {
        return `Phase ${phase.key} has a gate criterion a template cannot carry: ${criterion.key}`;
      }
      if (!isDeliverableCriterion(criterion.key)) continue;
      const deliverableKey = deliverableKeyOf(criterion.params);
      if (!deliverableKey) return `Phase ${phase.key} has a ${criterion.key} criterion without a deliverableKey`;
      if (!deliverables.has(deliverableKey)) return `Phase ${phase.key} refers to an unknown deliverable: ${deliverableKey}`;
    }
  }
  return null;
}

/** A task must not be its own ancestor. */
function ancestorError(blueprint: Blueprint): string | null {
  const parentOf = new Map(blueprint.tasks.map((task) => [task.key, task.parentKey ?? null]));
  for (const task of blueprint.tasks) {
    const seen = new Set<string>([task.key]);
    let current = parentOf.get(task.key) ?? null;
    while (current) {
      if (seen.has(current)) return `Task ${task.key} is its own ancestor`;
      seen.add(current);
      current = parentOf.get(current) ?? null;
    }
  }
  return null;
}

/** The refusal for a dependency that names an unknown task, repeats or loops, or null. */
function dependencyError(blueprint: Blueprint, tasks: ReadonlySet<string>): string | null {
  const pairs = new Set<string>();
  const successors = new Map<string, string[]>();
  for (const dependency of blueprint.dependencies) {
    if (!tasks.has(dependency.predecessor) || !tasks.has(dependency.successor)) {
      return `A dependency refers to an unknown task: ${tasks.has(dependency.predecessor) ? dependency.successor : dependency.predecessor}`;
    }
    if (dependency.predecessor === dependency.successor) return `Task ${dependency.predecessor} cannot depend on itself`;
    const pair = `${dependency.predecessor}>${dependency.successor}`;
    if (pairs.has(pair)) return `Duplicate dependency: ${dependency.predecessor} to ${dependency.successor}`;
    pairs.add(pair);
    successors.set(dependency.predecessor, [...(successors.get(dependency.predecessor) ?? []), dependency.successor]);
  }
  const looping = loopingTask(blueprint.tasks.map((task) => task.key), successors);
  return looping === null ? null : `The dependencies of task ${looping} run in a circle`;
}

/** The first task found on a dependency circle (depth-first, 0 new, 1 on the path, 2 done), or null. */
function loopingTask(taskKeys: readonly string[], successors: ReadonlyMap<string, string[]>): string | null {
  const state = new Map<string, 1 | 2>();
  const visit = (key: string): string | null => {
    state.set(key, 1);
    for (const next of successors.get(key) ?? []) {
      const seen = state.get(next);
      if (seen === 1) return next;
      if (seen === undefined) {
        const found = visit(next);
        if (found) return found;
      }
    }
    state.set(key, 2);
    return null;
  };
  for (const key of taskKeys) {
    if (state.has(key)) continue;
    const found = visit(key);
    if (found) return found;
  }
  return null;
}

// ── Summary ─────────────────────────────────────────────────────────────────

/** What the gallery shows of a template. */
export function summarizeBlueprint(blueprint: Blueprint): BlueprintSummary {
  return {
    durationDays: blueprint.durationDays,
    tasks: blueprint.tasks.length,
    milestones: blueprint.milestones.length,
    phases: blueprint.phases.length,
    deliverables: blueprint.deliverables.length,
    raidItems: blueprint.raid.length,
    stages: blueprint.stages.length,
    roles: blueprint.roles.length,
  };
}

/**
 * What the gallery shows of a stored blueprint, without validating it: a
 * template that no longer passes the schema still lists (and can be deleted).
 */
export function summarizeStoredBlueprint(stored: unknown): BlueprintSummary {
  const record = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
  const length = (key: string) => (Array.isArray(record[key]) ? (record[key] as unknown[]).length : 0);
  return {
    durationDays: typeof record.durationDays === 'number' ? record.durationDays : 0,
    tasks: length('tasks'),
    milestones: length('milestones'),
    phases: length('phases'),
    deliverables: length('deliverables'),
    raidItems: length('raid'),
    stages: length('stages'),
    roles: length('roles'),
  };
}

// ── Save as template: rows into a blueprint ─────────────────────────────────

/** Everything of a project a blueprint is built from. Only live rows. */
export interface BlueprintSource {
  project: ProjectRow;
  /** Active members. */
  members: MemberRow[];
  stages: StageRow[];
  phases: PhaseRow[];
  milestones: MilestoneRow[];
  deliverables: DeliverableRow[];
  tasks: TaskRow[];
  dependencies: DependencyRow[];
  raidItems: RaidRow[];
}

const RAID_KIND_ORDER: readonly RaidKind[] = ['risk', 'assumption', 'issue', 'dependency'];
const MEMBER_ROLES: readonly BlueprintMemberRole[] = ['owner', 'admin', 'member', 'viewer'];

function compareBy<T>(...keys: Array<(row: T) => string | number>): (a: T, b: T) => number {
  return (a, b) => {
    for (const key of keys) {
      const left = key(a);
      const right = key(b);
      if (left < right) return -1;
      if (left > right) return 1;
    }
    return 0;
  };
}

/** A member role as a blueprint knows it (any other spelling is a plain member). */
function memberRoleOf(role: string | null | undefined): BlueprintMemberRole {
  const lowered = (role ?? '').toLowerCase();
  return (MEMBER_ROLES as readonly string[]).includes(lowered) ? (lowered as BlueprintMemberRole) : 'member';
}

interface BlueprintParts {
  tasks: TaskRow[];
  milestones: MilestoneRow[];
  deliverables: DeliverableRow[];
  phases: PhaseRow[];
  stages: StageRow[];
  raidItems: RaidRow[];
}

/** The rows of a project in the order a blueprint lists them. */
function sortedParts(source: BlueprintSource): BlueprintParts {
  return {
    tasks: source.tasks
      .filter((task) => task.status !== 'cancelled')
      .sort(compareBy<TaskRow>((task) => task.position, (task) => task.id)),
    milestones: [...source.milestones].sort(compareBy<MilestoneRow>((row) => row.dueDate.getTime(), (row) => row.id)),
    deliverables: [...source.deliverables].sort(compareBy<DeliverableRow>((row) => row.position, (row) => row.number)),
    phases: [...source.phases].sort(compareBy<PhaseRow>((row) => row.position, (row) => row.id)),
    stages: [...source.stages].sort(compareBy<StageRow>((row) => row.position, (row) => row.id)),
    raidItems: source.raidItems
      .filter((item) => item.closedAt === null)
      .sort(compareBy<RaidRow>((row) => RAID_KIND_ORDER.indexOf(row.kind), (row) => row.number)),
  };
}

/** The role a member holds on the project, null for someone who is not a member. */
function projectRoleOf(membership: ReadonlyMap<string, string | null | undefined>, userId: string): BlueprintMemberRole | null {
  return membership.has(userId) ? memberRoleOf(membership.get(userId)) : null;
}

/** The people a blueprint turns into roles, after the project manager and the sponsor, in the order they first appear. */
function otherPeople(source: BlueprintSource, settings: ProjectSettings, parts: BlueprintParts): Array<string | null | undefined> {
  const people: Array<string | null | undefined> = [];
  for (const member of [...source.members].sort(compareBy<MemberRow>((row) => row.joinedAt.getTime(), (row) => row.id))) {
    people.push(member.userId);
  }
  people.push(...(settings.changeControl?.boardMemberIds ?? []));
  for (const task of parts.tasks) people.push(...assigneesOf(task));
  for (const row of [...parts.milestones, ...parts.deliverables, ...parts.raidItems]) people.push(row.ownerId);
  return people;
}

/** The roles of a blueprint: the project manager, the sponsor, then everyone else; `roleOf` maps a user to the role key. */
function assignRoles(
  source: BlueprintSource,
  settings: ProjectSettings,
  parts: BlueprintParts,
  roleLabels: Readonly<Record<string, string>>,
): { roles: Blueprint['roles']; roleOf: (userId: string | null | undefined) => string | null } {
  const roles: Blueprint['roles'] = [];
  const roleByUser = new Map<string, string>();
  const membership = new Map(source.members.map((member) => [member.userId, member.role]));
  const label = (key: string, fallback: string) => roleLabels[key]?.trim() || fallback;
  const addRole = (userId: string | null | undefined, key: string, fallback: string, projectRole: BlueprintMemberRole | null) => {
    if (!userId || roleByUser.has(userId)) return;
    roleByUser.set(userId, key);
    roles.push({ key, label: label(key, fallback), projectRole });
  };
  addRole(source.project.projectManagerId, PROJECT_MANAGER_ROLE, 'Project manager', 'owner');
  const sponsorId = settings.sponsorId ?? null;
  addRole(sponsorId, SPONSOR_ROLE, 'Sponsor', projectRoleOf(membership, sponsorId ?? ''));
  let others = 0;
  for (const userId of otherPeople(source, settings, parts)) {
    if (!userId || roleByUser.has(userId)) continue;
    others += 1;
    addRole(userId, `member_${others}`, `Team member ${others}`, projectRoleOf(membership, userId));
  }
  const roleOf = (userId: string | null | undefined): string | null => (userId ? (roleByUser.get(userId) ?? null) : null);
  return { roles, roleOf };
}

/** The earliest date any task, milestone, phase or deliverable has, or null. */
function earliestDate(parts: BlueprintParts): Date | null {
  const dated: Date[] = [];
  for (const task of parts.tasks) dated.push(...presentDates(task.startDate, task.dueDate));
  for (const row of parts.milestones) dated.push(row.dueDate);
  for (const row of parts.phases) dated.push(...presentDates(row.plannedStart, row.plannedEnd));
  for (const row of parts.deliverables) dated.push(...presentDates(row.plannedStart, row.plannedEnd));
  return dated.length === 0 ? null : new Date(Math.min(...dated.map((date) => date.getTime())));
}

function presentDates(...dates: Array<Date | null | undefined>): Date[] {
  return dates.filter((date): date is Date => Boolean(date));
}

/**
 * A gate criterion as a blueprint stores it: a deliverable by its local key, a
 * decision (or a deliverable that is gone) as a manual criterion; see the notes
 * above {@link upgradeCriterion}.
 */
function blueprintCriterion(
  criterion: PhaseRow['gateCriteria'][number],
  deliverableKeys: ReadonlyMap<string, string>,
): BlueprintCriterion {
  if ('manual' in criterion) return { manual: criterion.manual };
  if (isDeliverableCriterion(criterion.key)) {
    const id = criterion.params?.deliverableId;
    const local = typeof id === 'string' ? deliverableKeys.get(id) : undefined;
    if (!local) return { manual: deliverableCriterionText(criterion.key, null) };
    const { deliverableId: _source, ...rest } = criterion.params ?? {};
    return { key: criterion.key, params: { ...rest, deliverableKey: local } };
  }
  if (criterion.key === DECISION_CRITERION_KEY) return { manual: DECISION_CRITERION_TEXT };
  if (!(GATE_CRITERION_KEYS as readonly string[]).includes(criterion.key)) return { manual: criterion.key };
  return criterion.params ? { key: criterion.key, params: criterion.params } : { key: criterion.key };
}

/** The dependencies between tasks, as local keys: both the typed rows and the legacy arrays, without circles. */
function blueprintDependenciesOf(
  source: BlueprintSource,
  tasks: readonly TaskRow[],
  taskKeys: ReadonlyMap<string, string>,
): Blueprint['dependencies'] {
  const dependencies = new Map<string, Blueprint['dependencies'][number]>();
  const addDependency = (predecessorId: string, successorId: string, type: DependencyRow['type'], lagDays: number) => {
    const predecessor = taskKeys.get(predecessorId);
    const successor = taskKeys.get(successorId);
    if (!predecessor || !successor || predecessor === successor) return;
    const pair = `${predecessor}>${successor}`;
    if (!dependencies.has(pair)) dependencies.set(pair, { predecessor, successor, type, lagDays });
  };
  // The typed rows win over the arrays, so they go first.
  for (const row of [...source.dependencies].sort(compareBy<DependencyRow>((r) => r.createdAt.getTime(), (r) => r.id))) {
    addDependency(row.predecessorId, row.successorId, row.type, row.lagDays);
  }
  for (const task of tasks) {
    for (const predecessorId of task.dependsOn ?? []) addDependency(predecessorId, task.id, 'fs', 0);
    for (const successorId of task.blocks ?? []) addDependency(task.id, successorId, 'fs', 0);
  }
  // A circle in the source (the old arrays allowed no cycles, but be safe) would make an unusable template: drop the offending pairs.
  return withoutCycles([...dependencies.values()]);
}

/** The settings a blueprint carries over; board members become roles. */
function blueprintSettingsOf(settings: ProjectSettings, roleOf: (userId: string | null | undefined) => string | null): Blueprint['settings'] {
  const blueprintSettings: Blueprint['settings'] = {};
  if (settings.schedule) {
    blueprintSettings.schedule = { workingDays: [...settings.schedule.workingDays], autoSchedule: settings.schedule.autoSchedule };
  }
  if (settings.changeControl) {
    blueprintSettings.changeControl = {
      costLimit: settings.changeControl.costLimit,
      scheduleLimitDays: settings.changeControl.scheduleLimitDays,
      boardRoles: [...new Set(settings.changeControl.boardMemberIds.map(roleOf).filter((role): role is string => role !== null))],
    };
  }
  if (settings.statusReport) {
    blueprintSettings.statusReport = {
      cadence: settings.statusReport.cadence,
      weekday: settings.statusReport.weekday,
      hour: settings.statusReport.hour,
      recipientsRule: settings.statusReport.recipients?.rule ?? 'sponsor',
    };
  }
  if (settings.communicationPlan && settings.communicationPlan.length > 0) {
    blueprintSettings.communicationPlan = settings.communicationPlan.map((entry) => ({
      what: entry.what,
      audience: entry.audience,
      cadence: entry.cadence,
      channel: entry.channel,
    }));
  }
  if (typeof settings.riskAppetite === 'number') blueprintSettings.riskAppetite = settings.riskAppetite;
  return blueprintSettings;
}

function blueprintRaidItem(item: RaidRow, roleOf: (userId: string | null | undefined) => string | null): Blueprint['raid'][number] {
  return {
    kind: item.kind,
    title: item.title,
    description: item.description ?? null,
    category: item.category ?? null,
    ownerRole: roleOf(item.ownerId),
    probability: item.probability ?? null,
    impact: item.impact ?? null,
    strategy: item.strategy ?? null,
    trigger: item.trigger ?? null,
    costImpact: item.costImpact ?? null,
    scheduleImpactDays: item.scheduleImpactDays ?? null,
    reviewIntervalDays: item.reviewIntervalDays ?? null,
    confidence: item.confidence ?? null,
    ifWrong: item.ifWrong ?? null,
    severity: item.severity ?? null,
    direction: item.direction ?? null,
    partyType: item.partyType ?? null,
    partyName: item.partyName ?? null,
  };
}

/**
 * Turn a project into a blueprint: dates become offsets in working days from
 * the project start, people become roles (the project manager, the sponsor,
 * then everyone else in the order they first appear), ids become local keys.
 * Names, comments, time entries and files are not copied; tasks are copied
 * without their progress, and the register only with its open items.
 * `roleLabels` names the roles by key.
 */
export function buildBlueprint(source: BlueprintSource, roleLabels: Readonly<Record<string, string>> = {}): Blueprint {
  const { project } = source;
  const settings: ProjectSettings = project.settings ?? {};
  const workingDays = settings.schedule?.workingDays ?? [...DEFAULT_WORKING_DAYS];

  const parts = sortedParts(source);
  const { tasks, milestones, deliverables, phases, stages, raidItems } = parts;
  const { roles, roleOf } = assignRoles(source, settings, parts, roleLabels);

  const start = project.startDate ?? earliestDate(parts);
  const offsetOf = (date: Date | null | undefined): number | null => (start && date ? workingDayOffset(start, date, workingDays) : null);

  // ── Local keys ──
  const milestoneKeys = new Map(milestones.map((row, index) => [row.id, `m${index + 1}`]));
  const deliverableKeys = new Map(deliverables.map((row, index) => [row.id, `d${index + 1}`]));
  const taskKeys = new Map(tasks.map((row, index) => [row.id, `t${index + 1}`]));

  const blueprintTasks: Blueprint['tasks'] = tasks.map((task) => ({
    key: taskKeys.get(task.id) ?? '',
    parentKey: (task.parentTaskId && taskKeys.get(task.parentTaskId)) || null,
    title: task.title,
    description: task.description ?? null,
    priority: asPriority(task.priority),
    type: task.type ?? 'task',
    status: task.status === 'backlog' ? 'backlog' : 'todo',
    assigneeRoles: [...new Set(assigneesOf(task).map(roleOf).filter((role): role is string => role !== null))],
    startOffset: offsetOf(task.startDate),
    dueOffset: offsetOf(task.dueDate),
    estimatedHours: task.estimatedHours ?? null,
    storyPoints: task.storyPoints ?? null,
    milestoneKey: (task.milestoneId && milestoneKeys.get(task.milestoneId)) || null,
    deliverableKey: (task.deliverableId && deliverableKeys.get(task.deliverableId)) || null,
    labels: task.labels ?? null,
    tags: task.tags ?? null,
    isBillable: task.isBillable,
  }));

  const lastOffset = Math.max(
    0,
    ...blueprintTasks.flatMap((task) => [task.startOffset ?? 0, task.dueOffset ?? 0]),
    ...milestones.map((row) => offsetOf(row.dueDate) ?? 0),
    ...phases.flatMap((row) => [offsetOf(row.plannedStart) ?? 0, offsetOf(row.plannedEnd) ?? 0]),
    ...deliverables.flatMap((row) => [offsetOf(row.plannedStart) ?? 0, offsetOf(row.plannedEnd) ?? 0]),
  );
  const durationDays = Math.max(0, offsetOf(project.endDate) ?? lastOffset);

  return {
    version: 1,
    durationDays,
    roles,
    project: {
      type: project.type ?? null,
      methodology: project.methodology ?? null,
      priority: project.priority ?? null,
      visibility: project.visibility ?? null,
      color: project.color ?? null,
      icon: project.icon ?? null,
      budgetCurrency: project.budgetCurrency ?? null,
      billingMethod: project.billingMethod ?? null,
      isBillable: project.isBillable,
      trackTime: project.trackTime,
    },
    stages: stages.map((stage, index) => ({
      key: `s${index + 1}`,
      name: stage.name,
      color: stage.color ?? null,
      systemStatus: asSystemStatus(stage.systemStatus),
    })),
    phases: phases.map((phase, index) => ({
      key: `p${index + 1}`,
      name: phase.name,
      startOffset: offsetOf(phase.plannedStart),
      endOffset: offsetOf(phase.plannedEnd),
      gateCriteria: phase.gateCriteria.map((criterion) => blueprintCriterion(criterion, deliverableKeys)),
    })),
    milestones: milestones.map((row) => ({
      key: milestoneKeys.get(row.id) ?? '',
      name: row.name,
      description: row.description ?? null,
      offset: offsetOf(row.dueDate) ?? 0,
      isKey: row.isKeyMilestone === true,
      ownerRole: roleOf(row.ownerId),
    })),
    deliverables: deliverables.map((row) => ({
      key: deliverableKeys.get(row.id) ?? '',
      title: row.title,
      description: row.description ?? null,
      ownerRole: roleOf(row.ownerId),
      startOffset: offsetOf(row.plannedStart),
      endOffset: offsetOf(row.plannedEnd),
      acceptanceCriteria: row.acceptanceCriteria.map((criterion) => criterion.text),
      clientVisible: row.clientVisible,
    })),
    tasks: blueprintTasks,
    dependencies: blueprintDependenciesOf(source, tasks, taskKeys),
    raid: raidItems.map((item) => blueprintRaidItem(item, roleOf)),
    settings: blueprintSettingsOf(settings, roleOf),
  };
}

/** The member ids a task is assigned to: `assignee_ids`, else the one `assignee_id`. */
function assigneesOf(task: Pick<TaskRow, 'assigneeId' | 'assigneeIds'>): string[] {
  if (Array.isArray(task.assigneeIds) && task.assigneeIds.length > 0) return task.assigneeIds;
  return task.assigneeId ? [task.assigneeId] : [];
}

function asPriority(value: string): Blueprint['tasks'][number]['priority'] {
  return value === 'critical' || value === 'high' || value === 'low' || value === 'none' ? value : 'medium';
}

function asSystemStatus(value: string): Blueprint['stages'][number]['systemStatus'] {
  const known = ['backlog', 'todo', 'in_progress', 'review', 'testing', 'done', 'cancelled'] as const;
  return (known as readonly string[]).includes(value) ? (value as Blueprint['stages'][number]['systemStatus']) : 'in_progress';
}

/** The dependencies without the ones that close a circle (first come, first kept). */
function withoutCycles(dependencies: Blueprint['dependencies']): Blueprint['dependencies'] {
  const kept: Blueprint['dependencies'] = [];
  const successors = new Map<string, string[]>();
  const reaches = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...(successors.get(current) ?? []));
    }
    return false;
  };
  for (const dependency of dependencies) {
    // Adding predecessor -> successor closes a circle when the successor already reaches the predecessor.
    if (reaches(dependency.successor, dependency.predecessor)) continue;
    kept.push(dependency);
    successors.set(dependency.predecessor, [...(successors.get(dependency.predecessor) ?? []), dependency.successor]);
  }
  return kept;
}

// ── Create project: a blueprint into rows ───────────────────────────────────

/** What the copy options default to: everything. */
export function resolveCopy(copy: InstantiateCopy | undefined): Required<InstantiateCopy> {
  return {
    phases: copy?.phases ?? true,
    milestones: copy?.milestones ?? true,
    deliverables: copy?.deliverables ?? true,
    tasks: copy?.tasks ?? true,
    stages: copy?.stages ?? true,
    raid: copy?.raid ?? true,
    changeControl: copy?.changeControl ?? true,
    statusReport: copy?.statusReport ?? true,
  };
}

/** The first refusal for the roles of a request: a role the template does not have. */
export function instantiateRolesError(blueprint: Blueprint, roles: Readonly<Record<string, string>>): string | null {
  const known = new Set(blueprint.roles.map((entry) => entry.key));
  for (const role of Object.keys(roles)) if (!known.has(role)) return TEMPLATE_MESSAGES.unknownRole(role);
  return null;
}

/** The counter of a project's deliverables: scope `del:<projectId>`, prefix `D`. */
export function deliverableSequence(projectId: string): NumberSequence {
  return { scope: `del:${projectId}`, prefix: 'D' };
}

/**
 * How many workspace-wide task numbers the plan needs. The other numbers
 * (deliverables and register items) count per project, so a new project's
 * counters start at 1 and the plan writes them itself.
 */
export function neededTaskNumbers(blueprint: Blueprint, copy: Required<InstantiateCopy>): number {
  return copy.tasks ? blueprint.tasks.length : 0;
}

export interface InstantiateContext {
  /** The id of the new project (made up front: the plan's counters are scoped by it). */
  projectId: string;
  /** The member creating the project: its reporter, its owner member, and its manager when no role names one. */
  userId: string;
  now: Date;
  name: string;
  /** Midnight UTC of the start date. */
  start: Date;
  clientId: string | null;
  /** The person for each role key. */
  roles: Readonly<Record<string, string>>;
  copy: Required<InstantiateCopy>;
  /** The id of the template, kept on the project (`settings.templateId`). */
  templateId: string;
  newId: (prefix: string) => string;
  /** The workspace-wide task numbers allocated for the plan, one per task, in the blueprint's order. */
  taskNumbers: readonly number[];
}

export interface InstantiatePlan {
  projectId: string;
  endDate: Date;
  project: NewProjectRow;
  members: NewMemberRow[];
  stages: NewStageRow[];
  phases: NewPhaseRow[];
  milestones: NewMilestoneRow[];
  deliverables: NewDeliverableRow[];
  tasks: NewTaskRow[];
  dependencies: NewDependencyRow[];
  raidItems: NewRaidRow[];
  assessments: NewAssessmentRow[];
  /** The new project's own counters (deliverables, register items), set to the next free number. */
  sequences: NewSequenceRow[];
  counts: InstantiateResult['counts'];
}

const MEMBER_RANK: Record<BlueprintMemberRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** What every part of a plan shares: the request, the template's calendar and the date and person lookups. */
interface PlanScope {
  ctx: InstantiateContext;
  calendar: number[];
  at: (offset: number | null | undefined) => Date | null;
  personOf: (role: string | null | undefined) => string | null;
}

/** The creator owns the project; each role with a person joins as the template says. */
function planMembers(blueprint: Blueprint, scope: PlanScope): NewMemberRow[] {
  const { ctx } = scope;
  const memberRoles = new Map<string, BlueprintMemberRole>([[ctx.userId, 'owner']]);
  for (const role of blueprint.roles) {
    const person = scope.personOf(role.key);
    if (!person || !role.projectRole) continue;
    const current = memberRoles.get(person);
    if (!current || MEMBER_RANK[role.projectRole] > MEMBER_RANK[current]) memberRoles.set(person, role.projectRole);
  }
  return [...memberRoles].map(([memberId, role]) => ({
    id: ctx.newId('pmem'),
    projectId: ctx.projectId,
    userId: memberId,
    role,
    isActive: true,
    joinedAt: ctx.now,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  }));
}

function planStages(blueprint: Blueprint, { ctx }: PlanScope): NewStageRow[] {
  if (!ctx.copy.stages) return [];
  return blueprint.stages.map((stage, index) => ({
    id: ctx.newId('stg'),
    projectId: ctx.projectId,
    name: stage.name,
    color: stage.color,
    position: index,
    systemStatus: stage.systemStatus,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  }));
}

/** The column a new task of this status lands in: its own, else the neighbour, else the first. */
function stageFor(stages: readonly NewStageRow[], status: 'backlog' | 'todo'): string | null {
  const byStatus = (wanted: string) => stages.find((stage) => stage.systemStatus === wanted)?.id ?? null;
  return (status === 'backlog' ? (byStatus('backlog') ?? byStatus('todo')) : (byStatus('todo') ?? byStatus('backlog'))) ?? stages[0]?.id ?? null;
}

/**
 * A blueprint criterion as a phase row of the new project holds it: a
 * deliverable key becomes the new deliverable's id; with the deliverables not
 * copied, or for a decision, it is a manual criterion with a readable text.
 */
function instantiateCriterion(
  criterion: BlueprintCriterion,
  blueprint: Blueprint,
  deliverableIds: ReadonlyMap<string, string>,
): NonNullable<NewPhaseRow['gateCriteria']>[number] {
  if ('manual' in criterion) return { manual: criterion.manual, met: false, metAt: null };
  if (criterion.key === DECISION_CRITERION_KEY) return { manual: DECISION_CRITERION_TEXT, met: false, metAt: null };
  if (!isDeliverableCriterion(criterion.key)) return criterion;
  const local = deliverableKeyOf(criterion.params);
  const id = local ? deliverableIds.get(local) : undefined;
  if (!id) {
    const title = blueprint.deliverables.find((deliverable) => deliverable.key === local)?.title ?? null;
    return { manual: deliverableCriterionText(criterion.key, title), met: false, metAt: null };
  }
  const { deliverableKey: _local, ...rest } = criterion.params ?? {};
  return { key: criterion.key, params: { ...rest, deliverableId: id } };
}

function planPhases(blueprint: Blueprint, scope: PlanScope): NewPhaseRow[] {
  const { ctx } = scope;
  if (!ctx.copy.phases) return [];
  return blueprint.phases.map((phase, index) => ({
    id: ctx.newId('phs'),
    projectId: ctx.projectId,
    position: index,
    name: phase.name,
    plannedStart: scope.at(phase.startOffset),
    plannedEnd: scope.at(phase.endOffset),
    // The project starts in its first phase.
    status: index === 0 ? ('active' as const) : ('upcoming' as const),
    // Resolved against the new deliverables once those are made, see resolveGateCriteria.
    gateCriteria: [],
    createdBy: ctx.userId,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  }));
}

/** The phases with their gate criteria resolved against the new project's deliverables. */
function resolveGateCriteria(blueprint: Blueprint, phases: readonly NewPhaseRow[], deliverableIds: ReadonlyMap<string, string>): NewPhaseRow[] {
  return phases.map((phase, index) => ({
    ...phase,
    gateCriteria: (blueprint.phases[index]?.gateCriteria ?? []).map((criterion) => instantiateCriterion(criterion, blueprint, deliverableIds)),
  }));
}

function planMilestones(blueprint: Blueprint, scope: PlanScope): { rows: NewMilestoneRow[]; ids: Map<string, string> } {
  const { ctx } = scope;
  const ids = new Map<string, string>();
  if (!ctx.copy.milestones) return { rows: [], ids };
  const rows: NewMilestoneRow[] = blueprint.milestones.map((milestone) => {
    const id = ctx.newId('ms');
    ids.set(milestone.key, id);
    return {
      id,
      projectId: ctx.projectId,
      name: milestone.name,
      description: milestone.description,
      dueDate: addWorkingDays(ctx.start, milestone.offset, scope.calendar),
      status: 'pending',
      progress: '0',
      ownerId: scope.personOf(milestone.ownerRole),
      isKeyMilestone: milestone.isKey,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
  });
  return { rows, ids };
}

function planDeliverables(blueprint: Blueprint, scope: PlanScope): { rows: NewDeliverableRow[]; ids: Map<string, string> } {
  const { ctx } = scope;
  const ids = new Map<string, string>();
  if (!ctx.copy.deliverables) return { rows: [], ids };
  const rows: NewDeliverableRow[] = blueprint.deliverables.map((deliverable, index) => {
    const id = ctx.newId('dlv');
    ids.set(deliverable.key, id);
    return {
      id,
      projectId: ctx.projectId,
      number: index + 1,
      title: deliverable.title,
      description: deliverable.description,
      ownerId: scope.personOf(deliverable.ownerRole),
      status: 'not_started' as const,
      plannedStart: scope.at(deliverable.startOffset),
      plannedEnd: scope.at(deliverable.endOffset),
      acceptanceCriteria: deliverable.acceptanceCriteria.map((text) => ({ text, met: false, metAt: null })),
      position: index,
      clientVisible: deliverable.clientVisible,
      createdBy: ctx.userId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
  });
  return { rows, ids };
}

/** The typed dependency rows between the new tasks, and each task's legacy `dependsOn` and `blocks` arrays. */
function planDependencies(
  blueprint: Blueprint,
  { ctx }: PlanScope,
  taskIds: ReadonlyMap<string, string>,
): { rows: NewDependencyRow[]; dependsOn: Map<string, string[]>; blocks: Map<string, string[]> } {
  const dependsOn = new Map<string, string[]>();
  const blocks = new Map<string, string[]>();
  const rows: NewDependencyRow[] = [];
  if (!ctx.copy.tasks) return { rows, dependsOn, blocks };
  for (const dependency of blueprint.dependencies) {
    const predecessorId = taskIds.get(dependency.predecessor);
    const successorId = taskIds.get(dependency.successor);
    if (!predecessorId || !successorId) continue;
    rows.push({
      id: ctx.newId('tdp'),
      projectId: ctx.projectId,
      predecessorId,
      successorId,
      type: dependency.type,
      lagDays: dependency.lagDays,
      createdBy: ctx.userId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    });
    dependsOn.set(successorId, [...(dependsOn.get(successorId) ?? []), predecessorId]);
    blocks.set(predecessorId, [...(blocks.get(predecessorId) ?? []), successorId]);
  }
  return { rows, dependsOn, blocks };
}

/** What the new tasks refer to. */
interface TaskRefs {
  taskIds: ReadonlyMap<string, string>;
  milestoneIds: ReadonlyMap<string, string>;
  deliverableIds: ReadonlyMap<string, string>;
  stages: readonly NewStageRow[];
  dependsOn: ReadonlyMap<string, string[]>;
  blocks: ReadonlyMap<string, string[]>;
}

function planTasks(blueprint: Blueprint, scope: PlanScope, refs: TaskRefs): NewTaskRow[] {
  const { ctx } = scope;
  if (!ctx.copy.tasks) return [];
  return blueprint.tasks.map((task, index) => {
    const id = refs.taskIds.get(task.key) as string;
    const assignees = [...new Set(task.assigneeRoles.map(scope.personOf).filter((person): person is string => person !== null))];
    return {
      id,
      number: ctx.taskNumbers[index] as number,
      projectId: ctx.projectId,
      title: task.title,
      description: task.description,
      status: task.status,
      stageId: stageFor(refs.stages, task.status),
      priority: task.priority,
      type: task.type,
      assigneeId: assignees[0] ?? null,
      assigneeIds: assignees.length > 0 ? assignees : null,
      reporterId: ctx.userId,
      parentTaskId: task.parentKey ? (refs.taskIds.get(task.parentKey) ?? null) : null,
      milestoneId: task.milestoneKey ? (refs.milestoneIds.get(task.milestoneKey) ?? null) : null,
      deliverableId: task.deliverableKey ? (refs.deliverableIds.get(task.deliverableKey) ?? null) : null,
      startDate: scope.at(task.startOffset),
      dueDate: scope.at(task.dueOffset),
      estimatedHours: task.estimatedHours,
      storyPoints: task.storyPoints,
      labels: task.labels,
      tags: task.tags,
      isBillable: task.isBillable,
      dependsOn: refs.dependsOn.get(id) ?? null,
      blocks: refs.blocks.get(id) ?? null,
      position: index + 1,
      progress: '0',
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
  });
}

type RaidTemplateItem = Blueprint['raid'][number];

function raidBase(item: RaidTemplateItem, number: number, id: string, scope: PlanScope) {
  const { ctx } = scope;
  return {
    id,
    projectId: ctx.projectId,
    kind: item.kind,
    number,
    title: item.title,
    description: item.description,
    status: initialRaidStatus(item.kind),
    category: item.category,
    ownerId: scope.personOf(item.ownerRole),
    closedAt: null,
    customFields: null,
    createdBy: ctx.userId,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  } satisfies NewRaidRow;
}

/** The row of an assumption, issue or dependency (a risk without a score has none). */
function plainRaidRow(item: RaidTemplateItem, base: ReturnType<typeof raidBase>): NewRaidRow | null {
  switch (item.kind) {
    case 'assumption':
      return { ...base, confidence: item.confidence, ifWrong: item.ifWrong };
    case 'issue':
      return { ...base, severity: item.severity ?? 'medium' };
    case 'dependency':
      return { ...base, direction: item.direction, partyType: item.partyType, partyName: item.partyName };
    default:
      return null;
  }
}

/** The register's starting items, and a first assessment for each scored risk (the start of its trend). */
function planRaid(blueprint: Blueprint, scope: PlanScope): { raidItems: NewRaidRow[]; assessments: NewAssessmentRow[] } {
  const { ctx } = scope;
  const raidItems: NewRaidRow[] = [];
  const assessments: NewAssessmentRow[] = [];
  if (!ctx.copy.raid) return { raidItems, assessments };
  const used: Record<RaidKind, number> = { risk: 0, assumption: 0, issue: 0, dependency: 0 };
  for (const item of blueprint.raid) {
    used[item.kind] += 1;
    const id = ctx.newId('raid');
    const base = raidBase(item, used[item.kind], id, scope);
    if (item.kind === 'risk' && item.probability !== null && item.impact !== null) {
      const band = riskBand(riskScore(item.probability, item.impact));
      raidItems.push({
        ...base,
        dueAt: nextReviewAt(ctx.now, band, item.reviewIntervalDays),
        probability: item.probability,
        impact: item.impact,
        strategy: item.strategy,
        trigger: item.trigger,
        costImpact: item.costImpact,
        scheduleImpactDays: item.scheduleImpactDays,
        reviewIntervalDays: item.reviewIntervalDays,
      });
      assessments.push({
        id: ctx.newId('rasm'),
        itemId: id,
        projectId: ctx.projectId,
        probability: item.probability,
        impact: item.impact,
        residualProbability: null,
        residualImpact: null,
        note: null,
        assessedBy: ctx.userId,
        assessedAt: ctx.now,
      });
      continue;
    }
    const row = plainRaidRow(item, base);
    if (row) raidItems.push(row);
  }
  return { raidItems, assessments };
}

/** The project's settings: what the template carries over, with its roles turned into the people of the request. */
function planSettings(blueprint: Blueprint, scope: PlanScope, phases: readonly NewPhaseRow[]): ProjectSettings {
  const { copy, templateId } = scope.ctx;
  const settings: ProjectSettings = { templateId };
  if (blueprint.settings.schedule) {
    settings.schedule = {
      workingDays: [...blueprint.settings.schedule.workingDays],
      holidays: [],
      autoSchedule: blueprint.settings.schedule.autoSchedule,
    };
  }
  if (copy.changeControl && blueprint.settings.changeControl) {
    const board = blueprint.settings.changeControl.boardRoles.map(scope.personOf).filter((person): person is string => person !== null);
    settings.changeControl = {
      costLimit: blueprint.settings.changeControl.costLimit,
      scheduleLimitDays: blueprint.settings.changeControl.scheduleLimitDays,
      boardMemberIds: [...new Set(board)],
    };
  }
  if (copy.statusReport && blueprint.settings.statusReport) {
    const report = blueprint.settings.statusReport;
    settings.statusReport = { cadence: report.cadence, weekday: report.weekday, hour: report.hour, recipients: { rule: report.recipientsRule } };
    if (blueprint.settings.communicationPlan) {
      settings.communicationPlan = blueprint.settings.communicationPlan.map((entry) => ({ ...entry }));
    }
  }
  if (typeof blueprint.settings.riskAppetite === 'number') settings.riskAppetite = blueprint.settings.riskAppetite;
  const sponsor = scope.personOf(SPONSOR_ROLE);
  if (sponsor) settings.sponsorId = sponsor;
  if (phases.length > 0 && phases[0]) settings.currentPhaseId = phases[0].id;
  return settings;
}

/** The new project's own counters (deliverables, register items), set to the next free number. */
function planSequences(
  { ctx }: PlanScope,
  deliverableCount: number,
  raidItems: readonly NewRaidRow[],
): NewSequenceRow[] {
  const sequences: NewSequenceRow[] = [];
  const addSequence = (sequence: NumberSequence, used: number) => {
    if (used > 0) {
      sequences.push({ id: ctx.newId('seq'), scope: sequence.scope, prefix: sequence.prefix, nextValue: used + 1, createdAt: ctx.now, updatedAt: ctx.now });
    }
  };
  addSequence(deliverableSequence(ctx.projectId), deliverableCount);
  for (const kind of RAID_KIND_ORDER) {
    addSequence(raidSequence(kind, ctx.projectId), raidItems.filter((item) => item.kind === kind).length);
  }
  return sequences;
}

/**
 * Every row of the new project. Dates are counted in working days from the
 * start on the template's calendar; people come from `roles`; ids are made
 * with `newId`; numbers are the ones allocated for the plan. Rows the copy
 * options leave out are not made, and references to them are left empty.
 */
export function planInstantiation(blueprint: Blueprint, ctx: InstantiateContext): InstantiatePlan {
  const { now, projectId } = ctx;
  const calendar = blueprint.settings.schedule?.workingDays ?? [...DEFAULT_WORKING_DAYS];
  const scope: PlanScope = {
    ctx,
    calendar,
    at: (offset) => (offset === null || offset === undefined ? null : addWorkingDays(ctx.start, offset, calendar)),
    personOf: (role) => (role ? (ctx.roles[role] ?? null) : null),
  };
  const endDate = addWorkingDays(ctx.start, blueprint.durationDays, calendar);

  const members = planMembers(blueprint, scope);
  const stages = planStages(blueprint, scope);
  const phaseRows = planPhases(blueprint, scope);
  const milestones = planMilestones(blueprint, scope);
  const deliverables = planDeliverables(blueprint, scope);
  const phases = resolveGateCriteria(blueprint, phaseRows, deliverables.ids);

  const taskIds = new Map<string, string>();
  if (ctx.copy.tasks) for (const task of blueprint.tasks) taskIds.set(task.key, ctx.newId('task'));
  const dependencies = planDependencies(blueprint, scope, taskIds);
  const tasks = planTasks(blueprint, scope, {
    taskIds,
    milestoneIds: milestones.ids,
    deliverableIds: deliverables.ids,
    stages,
    dependsOn: dependencies.dependsOn,
    blocks: dependencies.blocks,
  });
  const { raidItems, assessments } = planRaid(blueprint, scope);

  const attributes = blueprint.project;
  const project: NewProjectRow = {
    id: projectId,
    name: ctx.name,
    status: 'Planning',
    customerId: ctx.clientId,
    projectManagerId: scope.personOf(PROJECT_MANAGER_ROLE) ?? ctx.userId,
    startDate: ctx.start,
    endDate,
    type: attributes.type,
    methodology: attributes.methodology,
    priority: attributes.priority,
    visibility: attributes.visibility,
    color: attributes.color,
    icon: attributes.icon,
    budgetCurrency: attributes.budgetCurrency,
    billingMethod: attributes.billingMethod,
    isBillable: attributes.isBillable,
    trackTime: attributes.trackTime,
    settings: planSettings(blueprint, scope, phases),
    createdAt: now,
    updatedAt: now,
  };

  return {
    projectId,
    endDate,
    project,
    members,
    stages,
    phases,
    milestones: milestones.rows,
    deliverables: deliverables.rows,
    tasks,
    dependencies: dependencies.rows,
    raidItems,
    assessments,
    sequences: planSequences(scope, deliverables.rows.length, raidItems),
    counts: {
      members: members.length,
      stages: stages.length,
      phases: phases.length,
      milestones: milestones.rows.length,
      deliverables: deliverables.rows.length,
      tasks: tasks.length,
      dependencies: dependencies.rows.length,
      raidItems: raidItems.length,
    },
  };
}
