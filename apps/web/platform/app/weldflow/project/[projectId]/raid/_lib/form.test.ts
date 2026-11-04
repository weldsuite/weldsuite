import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { interpolate } from '@weldsuite/i18n/provider';
import type { RaidItem } from '@weldsuite/app-api-client/domains/project-control';
import {
  assessFormSchema,
  assessValuesFromItem,
  assumptionFormSchema,
  assumptionValuesFromItem,
  buildAssessBody,
  buildConvertBody,
  buildCreateBody,
  buildRaidTaskBody,
  buildUpdateBody,
  convertFormSchemaFor,
  convertValuesFromItem,
  defaultAssumptionValues,
  defaultDependencyValues,
  defaultIssueValues,
  defaultRiskValues,
  dependencyFormSchema,
  dependencyValuesFromItem,
  issueValuesFromItem,
  parseCreateBody,
  parseUpdateBody,
  raidErrorMap,
  raidTaskFormSchema,
  riskFormSchema,
  riskValuesFromItem,
  type DependencyFormValues,
  type IssueFormValues,
  type RiskFormValues,
} from './form';

function item(kind: RaidItem['kind'], overrides: Partial<RaidItem> = {}): RaidItem {
  return {
    id: 'raid_1',
    projectId: 'proj_1',
    kind,
    number: 4,
    code: 'RSK-4',
    title: 'Data migration loses historical order data',
    description: 'Orders before 2022 live in the legacy shop.',
    status: 'mitigating',
    category: 'technical',
    ownerId: 'user_db',
    dueAt: new Date(2026, 9, 31, 12).toISOString(),
    closedAt: null,
    customFields: null,
    probability: 4,
    impact: 5,
    score: 20,
    band: 'critical',
    residualProbability: 2,
    residualImpact: 4,
    residualScore: 8,
    strategy: 'mitigate',
    trigger: 'Reconciliation fails by more than 0.5%.',
    costImpact: '18000.00',
    scheduleImpactDays: 10,
    reviewIntervalDays: null,
    confidence: null,
    ifWrong: null,
    severity: null,
    escalatedAt: null,
    direction: null,
    partyType: null,
    partyProjectId: null,
    partyName: null,
    createdBy: 'user_1',
    createdAt: '2026-09-15T10:00:00.000Z',
    updatedAt: '2026-10-27T10:00:00.000Z',
    deletedAt: null,
    taskProgress: { done: 1, total: 5 },
    ...overrides,
  };
}

const errorMap = raidErrorMap(en.projects.raid.validation, interpolate);

/** The messages of a failed parse, by field path. */
function messages(schema: { safeParse: (value: unknown, params?: { errorMap: typeof errorMap }) => { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } } }, value: unknown) {
  const result = schema.safeParse(value, { errorMap });
  return Object.fromEntries((result.error?.issues ?? []).map((issue) => [issue.path.join('.'), issue.message]));
}

describe('validation messages', () => {
  const copy = en.projects.raid.validation;

  it('asks for a title and a rating in plain words', () => {
    const found = messages(riskFormSchema, { ...defaultRiskValues(), title: '   ', probability: undefined });
    expect(found.title).toBe(copy.required);
    expect(found.probability).toBe(copy.ratingRequired);
  });

  it('limits the length of a title', () => {
    const found = messages(riskFormSchema, { ...defaultRiskValues(), title: 'x'.repeat(256) });
    expect(found.title).toBe('Use at most 255 characters');
  });

  it('checks the numbers of a risk', () => {
    expect(messages(riskFormSchema, { ...defaultRiskValues(), title: 'ok', scheduleImpactDays: -1 }).scheduleImpactDays).toBe(copy.invalidNumber);
    expect(messages(riskFormSchema, { ...defaultRiskValues(), title: 'ok', scheduleImpactDays: 2.5 }).scheduleImpactDays).toBe(copy.invalidWholeNumber);
    expect(messages(riskFormSchema, { ...defaultRiskValues(), title: 'ok', costImpact: Number.NaN }).costImpact).toBe(copy.invalidNumber);
  });

  it('checks the date of a form', () => {
    expect(messages(riskFormSchema, { ...defaultRiskValues(), title: 'ok', dueDate: '31-10-2026' }).dueDate).toBe(copy.invalidDate);
    expect(messages(riskFormSchema, { ...defaultRiskValues(), title: 'ok', dueDate: '2026-10-31' })).toEqual({});
    expect(messages(riskFormSchema, { ...defaultRiskValues(), title: 'ok', dueDate: '' })).toEqual({});
  });

  it('needs the after-mitigation probability and impact together', () => {
    const found = messages(riskFormSchema, { ...defaultRiskValues(), title: 'ok', residualProbability: 2, residualImpact: null });
    expect(found.residualImpact).toBe(copy.residualPair);
    expect(messages(assessFormSchema, { ...assessValuesFromItem(item('risk')), residualImpact: null }).residualImpact).toBe(copy.residualPair);
  });

  it('needs a project for a dependency on a project', () => {
    const found = messages(dependencyFormSchema, { ...defaultDependencyValues(), title: 'ok', partyType: 'project', partyProjectId: null });
    expect(found.partyProjectId).toBe(copy.partyProjectRequired);
  });

  it('needs the ratings of a risk made from an assumption, not of an issue made from a risk', () => {
    const values = { ...convertValuesFromItem(item('assumption')), title: 'ok' };
    const toRisk = messages(convertFormSchemaFor('risk'), values);
    expect(toRisk.probability).toBe(copy.ratingRequired);
    expect(toRisk.impact).toBe(copy.ratingRequired);
    expect(messages(convertFormSchemaFor('issue'), values)).toEqual({});
  });

  it('is translated in Dutch', () => {
    const dutch = raidErrorMap(nl.projects.raid.validation, interpolate);
    const result = riskFormSchema.safeParse({ ...defaultRiskValues(), title: '' }, { errorMap: dutch });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe(nl.projects.raid.validation.required);
  });
});

describe('create bodies', () => {
  it('builds a risk body the shared schema accepts', () => {
    const values: RiskFormValues = {
      ...defaultRiskValues('user_db'),
      title: 'Payment provider changes its API',
      description: 'v3 announced',
      category: 'technical',
      probability: 4,
      impact: 5,
      trigger: '  ',
      costImpact: 18000,
      scheduleImpactDays: 10,
      dueDate: '2026-11-16',
    };
    const body = parseCreateBody(buildCreateBody('risk', 'proj_1', values));
    expect(body).toMatchObject({
      kind: 'risk',
      projectId: 'proj_1',
      title: 'Payment provider changes its API',
      probability: 4,
      impact: 5,
      strategy: 'mitigate',
      category: 'technical',
      ownerId: 'user_db',
      costImpact: 18000,
      scheduleImpactDays: 10,
      trigger: null,
    });
    expect(body && 'dueAt' in body ? body.dueAt : null).toMatch(/^2026-11-16T|^2026-11-15T/);
    // The extras of the form never reach the request.
    expect(body).not.toHaveProperty('createTask');
    expect(body).not.toHaveProperty('milestoneId');
  });

  it('builds assumption, issue and dependency bodies the shared schema accepts', () => {
    const assumption = parseCreateBody(
      buildCreateBody('assumption', 'proj_1', { ...defaultAssumptionValues(), title: 'API v2 stays up', ifWrong: 'Move to v3', confidence: 'low' }),
    );
    expect(assumption).toMatchObject({ kind: 'assumption', confidence: 'low', ifWrong: 'Move to v3' });

    const issue = parseCreateBody(buildCreateBody('issue', 'proj_1', { ...defaultIssueValues(), title: 'Sessions drop', severity: 'high', escalated: true }));
    expect(issue).toMatchObject({ kind: 'issue', severity: 'high' });
    expect(issue && 'escalatedAt' in issue ? issue.escalatedAt : null).not.toBeNull();

    const dependency = parseCreateBody(
      buildCreateBody('dependency', 'proj_1', { ...defaultDependencyValues(), title: 'Logo and tokens', direction: 'inbound', partyType: 'team', partyName: ' Brand ' }),
    );
    expect(dependency).toMatchObject({ kind: 'dependency', direction: 'inbound', partyType: 'team', partyName: 'Brand', partyProjectId: null });
  });

  it('sends the project of a dependency on a project and no name', () => {
    const values: DependencyFormValues = {
      ...defaultDependencyValues(),
      title: 'Customer master data API',
      partyType: 'project',
      partyProjectId: 'proj_erp',
      partyName: 'ignored',
    };
    expect(parseCreateBody(buildCreateBody('dependency', 'proj_1', values))).toMatchObject({
      partyType: 'project',
      partyProjectId: 'proj_erp',
      partyName: null,
    });
  });

  it('clears the project when the party is not a project', () => {
    const values: DependencyFormValues = { ...defaultDependencyValues(), title: 'x', partyType: 'supplier', partyProjectId: 'proj_erp', partyName: 'ACME' };
    expect(parseCreateBody(buildCreateBody('dependency', 'proj_1', values))).toMatchObject({ partyProjectId: null, partyName: 'ACME' });
  });

  it('is refused by the shared schema when a field is out of range', () => {
    expect(parseCreateBody(buildCreateBody('risk', 'proj_1', { ...defaultRiskValues(), title: 'x', probability: 6 }))).toBeNull();
  });
});

describe('update bodies', () => {
  it('sends the editable fields of a risk but not its rating', () => {
    const risk = item('risk');
    const body = buildUpdateBody(risk, { ...riskValuesFromItem(risk), title: 'Renamed', strategy: 'transfer' });
    expect(body).not.toHaveProperty('probability');
    expect(body).not.toHaveProperty('impact');
    expect(body).not.toHaveProperty('status');
    expect(parseUpdateBody('risk', body)).toMatchObject({ title: 'Renamed', strategy: 'transfer', costImpact: 18000, scheduleImpactDays: 10 });
  });

  it('sends the status only when it changed', () => {
    const risk = item('risk');
    const changed = buildUpdateBody(risk, { ...riskValuesFromItem(risk), status: 'monitoring' });
    expect(parseUpdateBody('risk', changed)).toMatchObject({ status: 'monitoring' });
  });

  it('clears fields that were emptied', () => {
    const risk = item('risk');
    const body = parseUpdateBody('risk', buildUpdateBody(risk, { ...riskValuesFromItem(risk), description: '', trigger: ' ', ownerId: null, dueDate: '', costImpact: null }));
    expect(body).toMatchObject({ description: null, trigger: null, ownerId: null, dueAt: null, costImpact: null });
  });

  it('keeps the time an issue was escalated, sets it on, clears it off', () => {
    const escalated = item('issue', { severity: 'critical', escalatedAt: '2026-10-25T10:00:00.000Z', status: 'open' });
    const unchanged = buildUpdateBody(escalated, issueValuesFromItem(escalated));
    expect(unchanged).not.toHaveProperty('escalatedAt');

    const off = buildUpdateBody(escalated, { ...issueValuesFromItem(escalated), escalated: false } as IssueFormValues);
    expect(off).toMatchObject({ escalatedAt: null });

    const plain = item('issue', { severity: 'medium', status: 'open' });
    const on = parseUpdateBody('issue', buildUpdateBody(plain, { ...issueValuesFromItem(plain), escalated: true }));
    expect(on && 'escalatedAt' in on ? on.escalatedAt : null).not.toBeNull();
  });

  it('round-trips an assumption and a dependency through their forms', () => {
    const assumption = item('assumption', { confidence: 'medium', ifWrong: 'Late', status: 'open', category: null, strategy: null, trigger: null, costImpact: null, scheduleImpactDays: null });
    const assumptionValues = assumptionValuesFromItem(assumption);
    expect(assumptionFormSchema.safeParse(assumptionValues).success).toBe(true);
    expect(parseUpdateBody('assumption', buildUpdateBody(assumption, assumptionValues))).toMatchObject({ confidence: 'medium', ifWrong: 'Late' });

    const dependency = item('dependency', { direction: 'outbound', partyType: 'project', partyProjectId: 'proj_2', partyName: null, status: 'open', category: null, strategy: null, trigger: null, costImpact: null, scheduleImpactDays: null });
    const values = dependencyValuesFromItem(dependency);
    expect(dependencyFormSchema.safeParse(values).success).toBe(true);
    expect(parseUpdateBody('dependency', buildUpdateBody(dependency, values))).toMatchObject({ direction: 'outbound', partyProjectId: 'proj_2' });
  });
});

describe('assess, convert and task bodies', () => {
  it('builds an assessment with the after-mitigation target and a note', () => {
    const body = buildAssessBody({
      probability: 4,
      impact: 5,
      residualProbability: 2,
      residualImpact: 4,
      note: ' Trial migration dropped 1.8% ',
      nextReviewDate: '2026-11-10',
    });
    expect(body).toMatchObject({ probability: 4, impact: 5, residualProbability: 2, residualImpact: 4, note: 'Trial migration dropped 1.8%' });
    expect(body?.nextReviewAt).toBeDefined();
  });

  it('clears the target with nulls and leaves the review to the band when no date is given', () => {
    const body = buildAssessBody({ ...assessValuesFromItem(item('risk')), residualProbability: null, residualImpact: null });
    expect(body).toMatchObject({ residualProbability: null, residualImpact: null });
    expect(body).not.toHaveProperty('nextReviewAt');
    expect(body?.note).toBeNull();
  });

  it('starts an assessment from the current rating and target', () => {
    expect(assessValuesFromItem(item('risk'))).toMatchObject({ probability: 4, impact: 5, residualProbability: 2, residualImpact: 4, note: '', nextReviewDate: '' });
  });

  it('builds the conversion of an assumption to a risk, and of a risk to an issue', () => {
    const toRisk = buildConvertBody('risk', { title: 'Hosting costs exceed the estimate', probability: 3, impact: 3, severity: null, dueDate: '' });
    expect(toRisk).toEqual({ to: 'risk', title: 'Hosting costs exceed the estimate', probability: 3, impact: 3 });

    const toIssue = buildConvertBody('issue', { title: 'Orders were lost', probability: null, impact: null, severity: 'critical', dueDate: '2026-11-08' });
    expect(toIssue).toMatchObject({ to: 'issue', title: 'Orders were lost', severity: 'critical' });
    expect(toIssue).not.toHaveProperty('probability');
    expect(buildConvertBody('risk', { title: 'x', probability: null, impact: null, severity: null, dueDate: '' })).toBeNull();
  });

  it('starts a conversion with the title of the source and the severity of its band', () => {
    expect(convertValuesFromItem(item('risk'))).toMatchObject({ title: item('risk').title, severity: 'critical', probability: null });
  });

  it('builds a mitigation task', () => {
    const values = { title: 'Mitigate: Data migration', description: ' ', assigneeId: 'user_db', dueDate: '2026-11-04', priority: 'high' as const };
    expect(raidTaskFormSchema.safeParse(values).success).toBe(true);
    expect(buildRaidTaskBody(values)).toMatchObject({ title: 'Mitigate: Data migration', description: null, assigneeId: 'user_db', priority: 'high' });
    expect(buildRaidTaskBody({ ...values, title: '' })).toBeNull();
  });
});
