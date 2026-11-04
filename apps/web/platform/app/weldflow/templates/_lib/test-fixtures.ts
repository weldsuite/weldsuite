/** Fixtures shared by the tests of the templates page (not imported by app code). */

import { blueprintSchema, type Blueprint, type ProjectTemplateDetail } from '@weldsuite/app-api-client/schemas/project-closing';

export function makeBlueprint(overrides: Partial<Blueprint> = {}): Blueprint {
  return blueprintSchema.parse({
    version: 1,
    durationDays: 100,
    roles: [
      { key: 'project_manager', label: 'Project manager', projectRole: 'owner' },
      { key: 'sponsor', label: 'Sponsor', projectRole: null },
    ],
    project: {
      type: null,
      methodology: null,
      priority: null,
      visibility: null,
      color: null,
      icon: null,
      budgetCurrency: 'EUR',
      billingMethod: null,
      isBillable: true,
      trackTime: true,
    },
    stages: [{ key: 'todo', name: 'To do', color: null, systemStatus: 'todo' }],
    phases: [
      { key: 'discovery', name: 'Discovery', startOffset: 0, endOffset: 19, gateCriteria: [{ manual: 'Design signed off' }] },
      { key: 'build', name: 'Build', startOffset: 20, endOffset: 69, gateCriteria: [] },
    ],
    milestones: [{ key: 'm1', name: 'Design signed off', description: null, offset: 19, isKey: true, ownerRole: null }],
    deliverables: [],
    tasks: [
      { key: 't1', parentKey: null, title: 'One', description: null, priority: 'medium', type: 'task', status: 'todo', assigneeRoles: [], startOffset: 0, dueOffset: 5, estimatedHours: null, storyPoints: null, milestoneKey: null, deliverableKey: null, labels: null, tags: null, isBillable: true },
      { key: 't2', parentKey: null, title: 'Two', description: null, priority: 'medium', type: 'task', status: 'todo', assigneeRoles: [], startOffset: 0, dueOffset: 19, estimatedHours: null, storyPoints: null, milestoneKey: null, deliverableKey: null, labels: null, tags: null, isBillable: true },
      { key: 't3', parentKey: null, title: 'Three', description: null, priority: 'medium', type: 'task', status: 'todo', assigneeRoles: [], startOffset: 0, dueOffset: 30, estimatedHours: null, storyPoints: null, milestoneKey: null, deliverableKey: null, labels: null, tags: null, isBillable: true },
    ],
    dependencies: [],
    raid: [],
    settings: {
      changeControl: { costLimit: 5000, scheduleLimitDays: 5, boardRoles: ['sponsor', 'project_manager'] },
      statusReport: { cadence: 'biweekly', weekday: 5, hour: 16, recipientsRule: 'all_stakeholders' },
      riskAppetite: 12,
    },
    ...overrides,
  });
}

export function makeTemplate(overrides: Partial<ProjectTemplateDetail> = {}): ProjectTemplateDetail {
  const blueprint = overrides.blueprint ?? makeBlueprint();
  return {
    id: 'tpl_1',
    name: 'Website relaunch',
    description: 'New site or customer portal',
    shared: true,
    sourceProjectId: null,
    createdBy: 'u_sanne',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    usageCount: 4,
    summary: {
      durationDays: blueprint.durationDays,
      tasks: blueprint.tasks.length,
      milestones: blueprint.milestones.length,
      phases: blueprint.phases.length,
      deliverables: blueprint.deliverables.length,
      raidItems: blueprint.raid.length,
      stages: blueprint.stages.length,
      roles: blueprint.roles.length,
    },
    ...overrides,
    blueprint,
  };
}
