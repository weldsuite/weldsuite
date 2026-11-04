import { describe, expect, it } from 'vitest';
import type { schema } from '@weldsuite/worker-kit/db';
import {
  addWorkingDays,
  blueprintSchema,
  workingDayOffset,
  type Blueprint,
} from '@weldsuite/app-api-client/schemas/project-closing';
import {
  blueprintIntegrityError,
  buildBlueprint,
  deliverableSequence,
  instantiateRolesError,
  neededTaskNumbers,
  planInstantiation,
  readBlueprint,
  resolveCopy,
  summarizeBlueprint,
  summarizeStoredBlueprint,
  type BlueprintSource,
} from './project-templates';

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);

describe('working days', () => {
  it('counts Monday to Friday by default', () => {
    // Monday 2027-01-11.
    expect(iso(addWorkingDays(day('2027-01-11'), 0))).toBe('2027-01-11');
    expect(iso(addWorkingDays(day('2027-01-11'), 4))).toBe('2027-01-15');
    expect(iso(addWorkingDays(day('2027-01-11'), 5))).toBe('2027-01-18');
    expect(iso(addWorkingDays(day('2027-01-11'), 19))).toBe('2027-02-05');
  });

  it('falls back to Monday to Friday when no listed day is a weekday', () => {
    expect(iso(addWorkingDays(day('2027-01-11'), 5, [0, 8]))).toBe('2027-01-18');
    expect(workingDayOffset(day('2027-01-11'), day('2027-01-18'), [9])).toBe(5);
  });

  it('rolls a start on a weekend to the next working day', () => {
    // Saturday 2027-01-09.
    expect(iso(addWorkingDays(day('2027-01-09'), 0))).toBe('2027-01-11');
    expect(iso(addWorkingDays(day('2027-01-09'), 1))).toBe('2027-01-12');
  });

  it('counts back with a negative offset', () => {
    expect(iso(addWorkingDays(day('2027-01-18'), -1))).toBe('2027-01-15');
    expect(iso(addWorkingDays(day('2027-01-18'), -5))).toBe('2027-01-11');
  });

  it('uses the calendar it is given', () => {
    // Monday to Thursday.
    expect(iso(addWorkingDays(day('2027-01-11'), 4, [1, 2, 3, 4]))).toBe('2027-01-18');
    // Including Saturday.
    expect(iso(addWorkingDays(day('2027-01-11'), 5, [1, 2, 3, 4, 5, 6]))).toBe('2027-01-16');
  });

  it('is undone by workingDayOffset on a working day, before or after the start', () => {
    const start = day('2027-01-13');
    for (let offset = -12; offset <= 30; offset += 1) {
      const date = addWorkingDays(start, offset);
      expect(workingDayOffset(start, date)).toBe(offset);
    }
  });

  it('counts a date on a non-working day as the working day before it', () => {
    // Saturday 2027-01-16 after Monday the 11th is Friday the 15th: 4.
    expect(workingDayOffset(day('2027-01-11'), day('2027-01-16'))).toBe(4);
    expect(workingDayOffset(day('2027-01-11'), day('2027-01-17'))).toBe(4);
  });

  it('counts the same day as offset 0', () => {
    expect(workingDayOffset(day('2027-01-11'), day('2027-01-11'))).toBe(0);
  });
});

// ── Fixtures: a small project ───────────────────────────────────────────────

type Row<K extends keyof typeof schema> = (typeof schema)[K] extends { $inferSelect: infer R } ? R : never;

const at = (value: string) => new Date(`${value}T00:00:00.000Z`);

function source(): BlueprintSource {
  const project = {
    id: 'prj_src',
    name: 'Customer Portal',
    projectManagerId: 'u_pm',
    status: 'Active',
    startDate: at('2027-01-11'),
    endDate: at('2027-02-05'),
    type: 'software',
    methodology: 'agile',
    priority: 'high',
    visibility: 'private',
    color: '#336699',
    icon: 'rocket',
    budgetCurrency: 'EUR',
    billingMethod: 'fixed',
    isBillable: true,
    trackTime: true,
    settings: {
      sponsorId: 'u_sp',
      changeControl: { costLimit: 8000, scheduleLimitDays: 3, boardMemberIds: ['u_sp', 'u_pm', 'u_fin'] },
      statusReport: { cadence: 'biweekly', weekday: 5, hour: 15, recipients: { stakeholderIds: ['stk_1'] } },
      schedule: { workingDays: [1, 2, 3, 4, 5], holidays: ['2027-01-14'], autoSchedule: true },
      communicationPlan: [{ what: 'Status', audience: 'Sponsor', cadence: 'Weekly', channel: 'Email' }],
      riskAppetite: 12,
    },
  } as unknown as Row<'projects'>;

  const members = [
    { id: 'pm_1', projectId: 'prj_src', userId: 'u_pm', role: 'owner', joinedAt: at('2026-12-01') },
    { id: 'pm_2', projectId: 'prj_src', userId: 'u_dev', role: 'member', joinedAt: at('2026-12-02') },
    { id: 'pm_3', projectId: 'prj_src', userId: 'u_view', role: 'viewer', joinedAt: at('2026-12-03') },
  ] as unknown as Row<'projectMembers'>[];

  const stages = [
    { id: 'stg_2', name: 'To Do', color: '#c4b5fd', position: 1, systemStatus: 'todo' },
    { id: 'stg_1', name: 'Backlog', color: '#94a3b8', position: 0, systemStatus: 'backlog' },
    { id: 'stg_3', name: 'Done', color: null, position: 2, systemStatus: 'done' },
  ] as unknown as Row<'projectPipelineStages'>[];

  const phases = [
    {
      id: 'phs_1',
      position: 0,
      name: 'Build',
      plannedStart: at('2027-01-11'),
      plannedEnd: at('2027-01-22'),
      gateCriteria: [
        { key: 'deliverable_accepted', params: { deliverableId: 'dlv_1' } },
        { key: 'deliverable_tasks_done', params: { deliverableId: 'dlv_gone' } },
        { key: 'decision_decided', params: { decisionId: 'dec_1' } },
        { key: 'no_open_risk_above', params: { band: 'high' } },
        { manual: 'Design signed', met: true, metAt: '2027-01-20T00:00:00.000Z' },
      ],
    },
    { id: 'phs_2', position: 1, name: 'Go-live', plannedStart: at('2027-01-25'), plannedEnd: at('2027-02-05'), gateCriteria: [] },
  ] as unknown as Row<'projectPhases'>[];

  const milestones = [
    { id: 'ms_1', name: 'Design signed off', description: null, dueDate: at('2027-01-15'), ownerId: 'u_sp', isKeyMilestone: true },
  ] as unknown as Row<'milestones'>[];

  const deliverables = [
    {
      id: 'dlv_1',
      number: 4,
      position: 0,
      title: 'Ordering',
      description: 'Place orders',
      ownerId: 'u_dev',
      plannedStart: at('2027-01-12'),
      plannedEnd: at('2027-01-29'),
      acceptanceCriteria: [{ text: 'Checkout works', met: true, metAt: '2027-01-28T00:00:00.000Z' }],
      clientVisible: true,
    },
  ] as unknown as Row<'projectDeliverables'>[];

  const task = (overrides: Record<string, unknown>) =>
    ({
      projectId: 'prj_src',
      description: null,
      priority: 'medium',
      type: 'task',
      status: 'in_progress',
      assigneeId: null,
      assigneeIds: null,
      parentTaskId: null,
      milestoneId: null,
      deliverableId: null,
      startDate: null,
      dueDate: null,
      estimatedHours: null,
      storyPoints: null,
      labels: null,
      tags: null,
      isBillable: true,
      dependsOn: null,
      blocks: null,
      position: 0,
      ...overrides,
    }) as unknown as Row<'tasks'>;

  const tasks = [
    task({
      id: 'task_1',
      title: 'Build ordering',
      position: 1,
      assigneeId: 'u_dev',
      startDate: at('2027-01-11'),
      dueDate: at('2027-01-15'),
      milestoneId: 'ms_1',
      deliverableId: 'dlv_1',
      estimatedHours: '16.00',
      storyPoints: 5,
      labels: ['frontend'],
    }),
    task({ id: 'task_2', title: 'Write tests', position: 2, parentTaskId: 'task_1', status: 'backlog', assigneeIds: ['u_dev', 'u_view'] }),
    task({ id: 'task_3', title: 'Release', position: 3, dependsOn: ['task_1'], priority: 'critical', dueDate: at('2027-02-05') }),
    task({ id: 'task_4', title: 'Dropped idea', position: 4, status: 'cancelled' }),
    task({ id: 'task_5', title: 'Review', position: 5, assigneeId: 'u_fin', blocks: ['task_3'] }),
  ];

  const dependencies = [
    {
      id: 'tdp_1',
      projectId: 'prj_src',
      predecessorId: 'task_2',
      successorId: 'task_3',
      type: 'ss',
      lagDays: 2,
      createdAt: at('2027-01-05'),
    },
    // The same pair as task_3's `depends_on`, typed: it wins over the array.
    {
      id: 'tdp_2',
      projectId: 'prj_src',
      predecessorId: 'task_1',
      successorId: 'task_3',
      type: 'ff',
      lagDays: 1,
      createdAt: at('2027-01-06'),
    },
  ] as unknown as Row<'taskDependencies'>[];

  const raidItems = [
    {
      id: 'raid_1',
      kind: 'risk',
      number: 1,
      title: 'Data migration loses history',
      description: null,
      category: 'Technical',
      ownerId: 'u_dev',
      closedAt: null,
      probability: 3,
      impact: 4,
      strategy: 'mitigate',
      trigger: null,
      costImpact: '5000.00',
      scheduleImpactDays: 3,
      reviewIntervalDays: 14,
      confidence: null,
      ifWrong: null,
      severity: null,
      direction: null,
      partyType: null,
      partyName: null,
    },
    { id: 'raid_2', kind: 'issue', number: 1, title: 'Build is red', closedAt: at('2027-01-20'), ownerId: null, severity: 'high' },
    {
      id: 'raid_3',
      kind: 'assumption',
      number: 1,
      title: 'Client supplies content by week 8',
      description: 'Per contract',
      category: null,
      ownerId: 'u_sp',
      closedAt: null,
      probability: null,
      impact: null,
      strategy: null,
      trigger: null,
      costImpact: null,
      scheduleImpactDays: null,
      reviewIntervalDays: null,
      confidence: 'medium',
      ifWrong: 'Launch slips',
      severity: null,
      direction: null,
      partyType: null,
      partyName: null,
    },
  ] as unknown as Row<'projectRaidItems'>[];

  return { project, members, stages, phases, milestones, deliverables, tasks, dependencies, raidItems };
}

describe('buildBlueprint', () => {
  const blueprint = buildBlueprint(source());

  it('makes a blueprint the schema and the rules accept', () => {
    expect(blueprintSchema.safeParse(blueprint).success).toBe(true);
    expect(blueprintIntegrityError(blueprint)).toBeNull();
    expect(readBlueprint(JSON.parse(JSON.stringify(blueprint)))).toEqual({ ok: true, blueprint });
  });

  it('turns people into roles: the manager, the sponsor, then everyone else in order of appearance', () => {
    expect(blueprint.roles).toEqual([
      { key: 'project_manager', label: 'Project manager', projectRole: 'owner' },
      { key: 'sponsor', label: 'Sponsor', projectRole: null },
      { key: 'member_1', label: 'Team member 1', projectRole: 'member' },
      { key: 'member_2', label: 'Team member 2', projectRole: 'viewer' },
      { key: 'member_3', label: 'Team member 3', projectRole: null },
    ]);
  });

  it('names the roles it is told to', () => {
    const named = buildBlueprint(source(), { member_1: 'Tech lead', sponsor: ' Executive sponsor ' });
    expect(named.roles.map((role) => role.label)).toEqual(['Project manager', 'Executive sponsor', 'Tech lead', 'Team member 2', 'Team member 3']);
  });

  it('turns dates into working-day offsets from the start and leaves out names, ids and progress', () => {
    expect(blueprint.durationDays).toBe(19);
    expect(blueprint.tasks.map((task) => [task.key, task.startOffset, task.dueOffset])).toEqual([
      ['t1', 0, 4],
      ['t2', null, null],
      ['t3', null, 19],
      ['t4', null, null],
    ]);
    expect(blueprint.milestones).toEqual([
      { key: 'm1', name: 'Design signed off', description: null, offset: 4, isKey: true, ownerRole: 'sponsor' },
    ]);
    expect(blueprint.phases.map((phase) => [phase.key, phase.startOffset, phase.endOffset])).toEqual([
      ['p1', 0, 9],
      ['p2', 10, 19],
    ]);
    expect(JSON.stringify(blueprint)).not.toContain('task_1');
    expect(JSON.stringify(blueprint)).not.toContain('u_dev');
  });

  it('copies tasks without the cancelled ones, with local keys, parents, assignees as roles and the links to milestone and deliverable', () => {
    expect(blueprint.tasks.map((task) => task.title)).toEqual(['Build ordering', 'Write tests', 'Release', 'Review']);
    const [build, tests, release, review] = blueprint.tasks;
    expect(build).toMatchObject({
      key: 't1',
      parentKey: null,
      status: 'todo',
      assigneeRoles: ['member_1'],
      milestoneKey: 'm1',
      deliverableKey: 'd1',
      estimatedHours: '16.00',
      storyPoints: 5,
      labels: ['frontend'],
    });
    expect(tests).toMatchObject({ key: 't2', parentKey: 't1', status: 'backlog', assigneeRoles: ['member_1', 'member_2'] });
    expect(release).toMatchObject({ priority: 'critical', assigneeRoles: [] });
    expect(review).toMatchObject({ key: 't4', assigneeRoles: ['member_3'] });
  });

  it('merges the typed dependencies with the legacy arrays, the typed rows winning', () => {
    expect(blueprint.dependencies).toEqual([
      { predecessor: 't2', successor: 't3', type: 'ss', lagDays: 2 },
      { predecessor: 't1', successor: 't3', type: 'ff', lagDays: 1 },
      // `blocks` of t4 (task_5): task_5 blocks task_3.
      { predecessor: 't4', successor: 't3', type: 'fs', lagDays: 0 },
    ]);
  });

  it('copies the open register items only, with the fields of their kind', () => {
    expect(blueprint.raid.map((item) => [item.kind, item.title, item.ownerRole])).toEqual([
      ['risk', 'Data migration loses history', 'member_1'],
      ['assumption', 'Client supplies content by week 8', 'sponsor'],
    ]);
    expect(blueprint.raid[0]).toMatchObject({ probability: 3, impact: 4, strategy: 'mitigate', costImpact: '5000.00', reviewIntervalDays: 14, confidence: null });
    expect(blueprint.raid[1]).toMatchObject({ confidence: 'medium', ifWrong: 'Launch slips', probability: null });
  });

  it('copies deliverables with their acceptance criteria unticked, stages in order, and phases with manual gate criteria unticked', () => {
    expect(blueprint.deliverables).toEqual([
      {
        key: 'd1',
        title: 'Ordering',
        description: 'Place orders',
        ownerRole: 'member_1',
        startOffset: 1,
        endOffset: 14,
        acceptanceCriteria: ['Checkout works'],
        clientVisible: true,
      },
    ]);
    expect(blueprint.stages.map((stage) => [stage.key, stage.name, stage.systemStatus])).toEqual([
      ['s1', 'Backlog', 'backlog'],
      ['s2', 'To Do', 'todo'],
      ['s3', 'Done', 'done'],
    ]);
    expect(blueprint.phases[0]?.gateCriteria).toEqual([
      { key: 'deliverable_accepted', params: { deliverableKey: 'd1' } },
      { manual: 'Deliverable tasks done' },
      { manual: 'Decision decided' },
      { key: 'no_open_risk_above', params: { band: 'high' } },
      { manual: 'Design signed' },
    ]);
  });

  it('copies the change control, the report schedule, the calendar and the project attributes, with the board as roles', () => {
    expect(blueprint.settings).toEqual({
      schedule: { workingDays: [1, 2, 3, 4, 5], autoSchedule: true },
      changeControl: { costLimit: 8000, scheduleLimitDays: 3, boardRoles: ['sponsor', 'project_manager', 'member_3'] },
      statusReport: { cadence: 'biweekly', weekday: 5, hour: 15, recipientsRule: 'sponsor' },
      communicationPlan: [{ what: 'Status', audience: 'Sponsor', cadence: 'Weekly', channel: 'Email' }],
      riskAppetite: 12,
    });
    expect(blueprint.project).toMatchObject({ type: 'software', methodology: 'agile', budgetCurrency: 'EUR', isBillable: true });
    expect(JSON.stringify(blueprint)).not.toContain('Customer Portal');
  });

  it('works for an empty project', () => {
    const empty = buildBlueprint({
      project: { id: 'prj_e', name: 'Empty', projectManagerId: null, startDate: null, endDate: null, isBillable: true, trackTime: true, settings: null } as unknown as Row<'projects'>,
      members: [],
      stages: [],
      phases: [],
      milestones: [],
      deliverables: [],
      tasks: [],
      dependencies: [],
      raidItems: [],
    });
    expect(blueprintSchema.safeParse(empty).success).toBe(true);
    expect(empty).toMatchObject({ durationDays: 0, roles: [], tasks: [], settings: {} });
  });

  it('starts from the earliest date when the project has no start', () => {
    const noStart = source();
    noStart.project = { ...noStart.project, startDate: null, endDate: null };
    const built = buildBlueprint(noStart);
    expect(built.tasks[0]).toMatchObject({ startOffset: 0, dueOffset: 4 });
    expect(built.durationDays).toBe(19);
  });

  it('drops a dependency that would close a circle', () => {
    const circular = source();
    circular.dependencies = [
      ...circular.dependencies,
      { id: 'tdp_3', projectId: 'prj_src', predecessorId: 'task_3', successorId: 'task_2', type: 'fs', lagDays: 0, createdAt: at('2027-01-07') } as unknown as Row<'taskDependencies'>,
    ];
    const built = buildBlueprint(circular);
    expect(blueprintIntegrityError(built)).toBeNull();
  });
});

describe('blueprintIntegrityError', () => {
  const valid = () => structuredClone(buildBlueprint(source()));

  it('accepts what the builder makes', () => {
    expect(blueprintIntegrityError(valid())).toBeNull();
  });

  it('refuses a gate criterion that names a deliverable or a key the blueprint does not have', () => {
    const missing = valid();
    missing.phases[0]!.gateCriteria = [{ key: 'deliverable_accepted', params: { deliverableKey: 'd9' } }];
    expect(blueprintIntegrityError(missing)).toBe('Phase p1 refers to an unknown deliverable: d9');

    const sourceId = valid();
    sourceId.phases[0]!.gateCriteria = [{ key: 'deliverable_tasks_done', params: { deliverableId: 'dlv_1' } }];
    expect(blueprintIntegrityError(sourceId)).toBe('Phase p1 has a deliverable_tasks_done criterion without a deliverableKey');

    const decision = valid();
    decision.phases[0]!.gateCriteria = [{ key: 'decision_decided', params: { decisionId: 'dec_1' } }];
    expect(blueprintIntegrityError(decision)).toBe('Phase p1 has a gate criterion a template cannot carry: decision_decided');

    const unknown = valid();
    unknown.phases[0]!.gateCriteria = [{ key: 'made_up' }];
    expect(blueprintIntegrityError(unknown)).toBe('Phase p1 has an unknown gate criterion: made_up');
  });

  it('refuses duplicate keys', () => {
    const blueprint = valid();
    blueprint.tasks[1]!.key = 't1';
    expect(blueprintIntegrityError(blueprint)).toBe('Duplicate task key: t1');
  });

  it('refuses a reference to something the blueprint does not have', () => {
    const parent = valid();
    parent.tasks[1]!.parentKey = 't9';
    expect(blueprintIntegrityError(parent)).toBe('Task t2 refers to an unknown parent: t9');

    const milestone = valid();
    milestone.tasks[0]!.milestoneKey = 'm9';
    expect(blueprintIntegrityError(milestone)).toBe('Task t1 refers to an unknown milestone: m9');

    const deliverable = valid();
    deliverable.tasks[0]!.deliverableKey = 'd9';
    expect(blueprintIntegrityError(deliverable)).toBe('Task t1 refers to an unknown deliverable: d9');

    const role = valid();
    role.tasks[0]!.assigneeRoles = ['ghost'];
    expect(blueprintIntegrityError(role)).toBe('Task t1 refers to an unknown role: ghost');

    const board = valid();
    board.settings.changeControl!.boardRoles = ['ghost'];
    expect(blueprintIntegrityError(board)).toBe('The change board refers to an unknown role: ghost');

    const dependency = valid();
    dependency.dependencies[0]!.predecessor = 't9';
    expect(blueprintIntegrityError(dependency)).toBe('A dependency refers to an unknown task: t9');
  });

  it('refuses a task that is its own ancestor or depends on itself', () => {
    const ancestor = valid();
    ancestor.tasks[0]!.parentKey = 't2';
    expect(blueprintIntegrityError(ancestor)).toBe('Task t1 is its own ancestor');

    const self = valid();
    self.dependencies = [{ predecessor: 't1', successor: 't1', type: 'fs', lagDays: 0 }];
    expect(blueprintIntegrityError(self)).toBe('Task t1 cannot depend on itself');
  });

  it('refuses a repeated dependency and a circle', () => {
    const repeated = valid();
    repeated.dependencies = [
      { predecessor: 't1', successor: 't2', type: 'fs', lagDays: 0 },
      { predecessor: 't1', successor: 't2', type: 'ss', lagDays: 0 },
    ];
    expect(blueprintIntegrityError(repeated)).toBe('Duplicate dependency: t1 to t2');

    const circle = valid();
    circle.dependencies = [
      { predecessor: 't1', successor: 't2', type: 'fs', lagDays: 0 },
      { predecessor: 't2', successor: 't3', type: 'fs', lagDays: 0 },
      { predecessor: 't3', successor: 't1', type: 'fs', lagDays: 0 },
    ];
    expect(blueprintIntegrityError(circle)).toBe('The dependencies of task t1 run in a circle');
  });
});

describe('the blueprint schema', () => {
  it('refuses a risk without ratings and fields of another kind', () => {
    const blueprint = structuredClone(buildBlueprint(source()));
    blueprint.raid[0] = { ...blueprint.raid[0]!, probability: null };
    expect(blueprintSchema.safeParse(blueprint).success).toBe(false);

    const assumption = structuredClone(buildBlueprint(source()));
    assumption.raid[1] = { ...assumption.raid[1]!, strategy: 'avoid' };
    expect(blueprintSchema.safeParse(assumption).success).toBe(false);
  });

  it('refuses an unknown field, a bad key and a bad version', () => {
    const blueprint = buildBlueprint(source());
    expect(blueprintSchema.safeParse({ ...blueprint, extra: 1 }).success).toBe(false);
    expect(blueprintSchema.safeParse({ ...blueprint, version: 2 }).success).toBe(false);
    const badKey = structuredClone(blueprint);
    badKey.tasks[0]!.key = 'Task 1';
    expect(blueprintSchema.safeParse(badKey).success).toBe(false);
  });

  it('upgrades gate criteria stored with the source project ids into manual ones', () => {
    const stored = structuredClone(buildBlueprint(source()));
    stored.phases[0]!.gateCriteria = [
      { key: 'deliverable_accepted', params: { deliverableId: 'dlv_1' } },
      { key: 'deliverable_tasks_done', params: { deliverableKey: 'd1' } },
      { key: 'decision_decided', params: { decisionId: 'dec_1' } },
      { key: 'made_up' },
      { key: 'no_change_request_pending' },
    ];
    const read = readBlueprint(JSON.parse(JSON.stringify(stored)));
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.blueprint.phases[0]?.gateCriteria).toEqual([
        { manual: 'Deliverable accepted' },
        { key: 'deliverable_tasks_done', params: { deliverableKey: 'd1' } },
        { manual: 'Decision decided' },
        { manual: 'made_up' },
        { key: 'no_change_request_pending' },
      ]);
    }
  });

  it('reads a stored blueprint of another version or shape as unusable', () => {
    expect(readBlueprint({ version: 2 })).toEqual({ ok: false, message: 'This template was saved in a format that is not supported' });
    expect(readBlueprint(null)).toEqual({ ok: false, message: 'This template was saved in a format that is not supported' });
    expect(readBlueprint({ version: 1 })).toEqual({ ok: false, message: 'The template is no longer valid' });
  });
});

describe('summaries', () => {
  it('counts what a blueprint holds', () => {
    expect(summarizeBlueprint(buildBlueprint(source()))).toEqual({
      durationDays: 19,
      tasks: 4,
      milestones: 1,
      phases: 2,
      deliverables: 1,
      raidItems: 2,
      stages: 3,
      roles: 5,
    });
  });

  it('counts a stored blueprint without validating it', () => {
    expect(summarizeStoredBlueprint({ version: 9, tasks: [1, 2], durationDays: 5 })).toMatchObject({ tasks: 2, durationDays: 5, phases: 0 });
    expect(summarizeStoredBlueprint(null).tasks).toBe(0);
  });
});

// ── Create project ──────────────────────────────────────────────────────────

function ids() {
  const counters = new Map<string, number>();
  return (prefix: string) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next}`;
  };
}

function plan(blueprint: Blueprint, overrides: Partial<Parameters<typeof planInstantiation>[1]> = {}) {
  const copy = resolveCopy(overrides.copy);
  return planInstantiation(blueprint, {
    projectId: 'prj_new',
    userId: 'u_creator',
    now: new Date('2027-03-01T09:00:00.000Z'),
    name: 'Supplier Portal',
    // Wednesday.
    start: day('2027-03-03'),
    clientId: 'cmp_1',
    roles: { project_manager: 'u_new_pm', sponsor: 'u_new_sp', member_1: 'u_new_dev', member_2: 'u_new_view', member_3: 'u_new_fin' },
    copy,
    templateId: 'tpl_1',
    newId: ids(),
    taskNumbers: [101, 102, 103, 104],
    ...overrides,
  });
}

describe('planInstantiation', () => {
  const blueprint = buildBlueprint(source());

  it('computes the dates with the calendar, from the start', () => {
    const made = plan(blueprint);
    expect(iso(made.project.startDate as Date)).toBe('2027-03-03');
    // 19 working days after Wednesday the 3rd.
    expect(iso(made.endDate)).toBe('2027-03-30');
    expect(iso(made.project.endDate as Date)).toBe('2027-03-30');
    expect(made.tasks.map((task) => [task.title, iso(task.startDate as Date | null), iso(task.dueDate as Date | null)])).toEqual([
      ['Build ordering', '2027-03-03', '2027-03-09'],
      ['Write tests', null, null],
      ['Release', null, '2027-03-30'],
      ['Review', null, null],
    ]);
    expect(made.milestones.map((milestone) => iso(milestone.dueDate as Date))).toEqual(['2027-03-09']);
    expect(made.phases.map((phase) => [iso(phase.plannedStart as Date), iso(phase.plannedEnd as Date)])).toEqual([
      ['2027-03-03', '2027-03-16'],
      ['2027-03-17', '2027-03-30'],
    ]);
  });

  it('makes the project row from the template, the name, the client and the roles', () => {
    const made = plan(blueprint);
    expect(made.project).toMatchObject({
      id: 'prj_new',
      name: 'Supplier Portal',
      status: 'Planning',
      customerId: 'cmp_1',
      projectManagerId: 'u_new_pm',
      type: 'software',
      methodology: 'agile',
      budgetCurrency: 'EUR',
    });
    expect(made.project.settings).toMatchObject({
      templateId: 'tpl_1',
      sponsorId: 'u_new_sp',
      changeControl: { costLimit: 8000, scheduleLimitDays: 3, boardMemberIds: ['u_new_sp', 'u_new_pm', 'u_new_fin'] },
      statusReport: { cadence: 'biweekly', weekday: 5, hour: 15, recipients: { rule: 'sponsor' } },
      schedule: { workingDays: [1, 2, 3, 4, 5], holidays: [], autoSchedule: true },
      riskAppetite: 12,
    });
  });

  it('makes the creator the project manager and leaves the sponsor empty when no role names them', () => {
    const made = plan(blueprint, { roles: {} });
    expect(made.project.projectManagerId).toBe('u_creator');
    expect(made.project.settings).not.toHaveProperty('sponsorId');
    expect(made.members.map((member) => [member.userId, member.role])).toEqual([['u_creator', 'owner']]);
    expect(made.tasks[0]).toMatchObject({ assigneeId: null, assigneeIds: null });
  });

  it('joins the creator as owner and each filled role as the template says, once', () => {
    const made = plan(blueprint);
    expect(made.members.map((member) => [member.userId, member.role])).toEqual([
      ['u_creator', 'owner'],
      ['u_new_pm', 'owner'],
      ['u_new_dev', 'member'],
      ['u_new_view', 'viewer'],
    ]);
    const same = plan(blueprint, { roles: { project_manager: 'u_creator', member_1: 'u_creator' } });
    expect(same.members.map((member) => [member.userId, member.role])).toEqual([['u_creator', 'owner']]);
    const promoted = plan(blueprint, { roles: { member_2: 'u_new_dev', member_1: 'u_new_dev' } });
    expect(promoted.members.find((member) => member.userId === 'u_new_dev')?.role).toBe('member');
  });

  it('numbers the tasks from the allocated numbers and the deliverables and register per project from 1', () => {
    const made = plan(blueprint);
    expect(made.tasks.map((task) => task.number)).toEqual([101, 102, 103, 104]);
    expect(made.deliverables.map((deliverable) => deliverable.number)).toEqual([1]);
    expect(made.raidItems.map((item) => [item.kind, item.number])).toEqual([
      ['risk', 1],
      ['assumption', 1],
    ]);
    expect(made.sequences.map((sequence) => [sequence.scope, sequence.prefix, sequence.nextValue])).toEqual([
      ['del:prj_new', 'D', 2],
      ['rsk:prj_new', 'RSK-', 2],
      ['asm:prj_new', 'A-', 2],
    ]);
    expect(deliverableSequence('prj_new')).toEqual({ scope: 'del:prj_new', prefix: 'D' });
  });

  it('links tasks to their parent, milestone and deliverable, and writes the dependencies in both forms', () => {
    const made = plan(blueprint);
    const [build, tests, release, review] = made.tasks;
    expect(tests?.parentTaskId).toBe(build?.id);
    expect(build).toMatchObject({ milestoneId: made.milestones[0]?.id, deliverableId: made.deliverables[0]?.id, status: 'todo', reporterId: 'u_creator' });
    expect(made.dependencies.map((dependency) => [dependency.predecessorId, dependency.successorId, dependency.type, dependency.lagDays])).toEqual([
      [tests?.id, release?.id, 'ss', 2],
      [build?.id, release?.id, 'ff', 1],
      [review?.id, release?.id, 'fs', 0],
    ]);
    expect(release?.dependsOn).toEqual([tests?.id, build?.id, review?.id]);
    expect(build?.blocks).toEqual([release?.id]);
    expect(build?.dependsOn).toBeNull();
  });

  it('assigns tasks to the people of their roles', () => {
    const made = plan(blueprint);
    expect(made.tasks[0]).toMatchObject({ assigneeId: 'u_new_dev', assigneeIds: ['u_new_dev'] });
    expect(made.tasks[1]).toMatchObject({ assigneeId: 'u_new_dev', assigneeIds: ['u_new_dev', 'u_new_view'] });
    expect(made.milestones[0]?.ownerId).toBe('u_new_sp');
    expect(made.deliverables[0]?.ownerId).toBe('u_new_dev');
  });

  it('puts the tasks in the column of their status, and the first phase in progress', () => {
    const made = plan(blueprint);
    const stageByName = new Map(made.stages.map((stage) => [stage.name, stage.id]));
    expect(made.tasks[0]?.stageId).toBe(stageByName.get('To Do'));
    expect(made.tasks[1]?.stageId).toBe(stageByName.get('Backlog'));
    expect(made.phases.map((phase) => phase.status)).toEqual(['active', 'upcoming']);
    expect(made.project.settings?.currentPhaseId).toBe(made.phases[0]?.id);
    // The deliverable criterion points at the new deliverable, not the source project's.
    expect(made.phases[0]?.gateCriteria).toEqual([
      { key: 'deliverable_accepted', params: { deliverableId: made.deliverables[0]?.id } },
      { manual: 'Deliverable tasks done', met: false, metAt: null },
      { manual: 'Decision decided', met: false, metAt: null },
      { key: 'no_open_risk_above', params: { band: 'high' } },
      { manual: 'Design signed', met: false, metAt: null },
    ]);
    expect(made.deliverables[0]?.id).toBeTruthy();
    expect(made.deliverables[0]).toMatchObject({ status: 'not_started', acceptanceCriteria: [{ text: 'Checkout works', met: false, metAt: null }] });
  });

  it('turns a deliverable criterion into a manual one when the deliverables are not copied', () => {
    const made = plan(blueprint, { copy: resolveCopy({ deliverables: false }) });
    expect(made.phases[0]?.gateCriteria?.slice(0, 2)).toEqual([
      { manual: 'Deliverable accepted: Ordering', met: false, metAt: null },
      { manual: 'Deliverable tasks done', met: false, metAt: null },
    ]);
  });

  it('starts the register with the first status of each kind, assessing the risk', () => {
    const made = plan(blueprint);
    expect(made.raidItems[0]).toMatchObject({ kind: 'risk', status: 'identified', probability: 3, impact: 4, closedAt: null });
    // The next review is the band's, or the risk's own interval: 14 days.
    expect(iso(made.raidItems[0]?.dueAt as Date)).toBe('2027-03-15');
    expect(made.raidItems[1]).toMatchObject({ kind: 'assumption', status: 'open', confidence: 'medium' });
    expect(made.assessments).toHaveLength(1);
    expect(made.assessments[0]).toMatchObject({ itemId: made.raidItems[0]?.id, probability: 3, impact: 4, assessedBy: 'u_creator' });
  });

  it('leaves out what the copy options turn off, and the references to it', () => {
    const made = plan(blueprint, {
      copy: resolveCopy({ phases: false, milestones: false, deliverables: false, tasks: false, stages: false, raid: false, changeControl: false, statusReport: false }),
    });
    expect(made.counts).toEqual({ members: 4, stages: 0, phases: 0, milestones: 0, deliverables: 0, tasks: 0, dependencies: 0, raidItems: 0 });
    expect(made.sequences).toEqual([]);
    expect(made.project.settings).not.toHaveProperty('changeControl');
    expect(made.project.settings).not.toHaveProperty('statusReport');
    expect(made.project.settings).not.toHaveProperty('currentPhaseId');
    // The calendar and the template stay.
    expect(made.project.settings).toMatchObject({ templateId: 'tpl_1', schedule: { autoSchedule: true } });

    const withoutMilestones = plan(blueprint, { copy: resolveCopy({ milestones: false, deliverables: false, stages: false }) });
    expect(withoutMilestones.tasks[0]).toMatchObject({ milestoneId: null, deliverableId: null, stageId: null });
  });

  it('counts what it made', () => {
    expect(plan(blueprint).counts).toEqual({
      members: 4,
      stages: 3,
      phases: 2,
      milestones: 1,
      deliverables: 1,
      tasks: 4,
      dependencies: 3,
      raidItems: 2,
    });
  });

  it('counts working days on the template calendar', () => {
    const sixDay = structuredClone(blueprint);
    sixDay.settings.schedule = { workingDays: [1, 2, 3, 4, 5, 6], autoSchedule: false };
    // Monday the 8th plus 4 working days on a six-day week is Friday the 12th.
    expect(iso(plan(sixDay, { start: day('2027-03-08') }).tasks[0]?.dueDate as Date)).toBe('2027-03-12');
    expect(iso(plan(sixDay, { start: day('2027-03-08') }).project.endDate as Date)).toBe('2027-03-30');
  });

  it('is asked for the task numbers it needs', () => {
    expect(neededTaskNumbers(blueprint, resolveCopy(undefined))).toBe(4);
    expect(neededTaskNumbers(blueprint, resolveCopy({ tasks: false }))).toBe(0);
  });

  it('refuses a role the template does not have', () => {
    expect(instantiateRolesError(blueprint, { sponsor: 'u_1', member_1: 'u_2' })).toBeNull();
    expect(instantiateRolesError(blueprint, { ghost: 'u_1' })).toBe("The template has no role 'ghost'");
  });
});
