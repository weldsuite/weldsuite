import { describe, expect, it } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import {
  CONTROL_LINK_RELATIONS,
  CONTROL_LINK_TYPES,
  RAID_CLOSED_STATUSES as SCHEMA_CLOSED,
  RAID_KINDS as SCHEMA_KINDS,
  RAID_STATUSES as SCHEMA_STATUSES,
  RISK_BANDS,
} from '@weldsuite/app-api-client/schemas/project-control';
import {
  closedAtFor,
  conversionError,
  initialRaidStatus,
  isClosedStatus,
  linkEndsError,
  linkShapeError,
  raidCode,
  raidFieldsError,
  raidSequence,
  severityForBand,
  sourceStatusAfterConversion,
} from './raid';

describe('numbering', () => {
  it('scopes a counter per kind and project, with the register prefixes', () => {
    expect(raidSequence('risk', 'prj_1')).toEqual({ scope: 'rsk:prj_1', prefix: 'RSK-' });
    expect(raidSequence('assumption', 'prj_1')).toEqual({ scope: 'asm:prj_1', prefix: 'A-' });
    expect(raidSequence('issue', 'prj_1')).toEqual({ scope: 'iss:prj_1', prefix: 'ISS-' });
    expect(raidSequence('dependency', 'prj_1')).toEqual({ scope: 'dep:prj_1', prefix: 'DEP-' });
  });

  it('shows the display code', () => {
    expect(raidCode('risk', 4)).toBe('RSK-4');
    expect(raidCode('assumption', 1)).toBe('A-1');
    expect(raidCode('issue', 2)).toBe('ISS-2');
    expect(raidCode('dependency', 3)).toBe('DEP-3');
  });

  it('fits a scope key for the longest project id (255 characters) in the widened column', () => {
    expect(raidSequence('risk', 'p'.repeat(255)).scope.length).toBeLessThanOrEqual(300);
  });
});

describe('statuses', () => {
  it('starts each kind in the first status of its set', () => {
    expect(initialRaidStatus('risk')).toBe('identified');
    expect(initialRaidStatus('assumption')).toBe('open');
    expect(initialRaidStatus('issue')).toBe('open');
    expect(initialRaidStatus('dependency')).toBe('open');
  });

  it('knows which statuses are closed', () => {
    expect(isClosedStatus('risk', 'mitigating')).toBe(false);
    expect(isClosedStatus('risk', 'occurred')).toBe(true);
    expect(isClosedStatus('risk', 'closed')).toBe(true);
    expect(isClosedStatus('assumption', 'open')).toBe(false);
    expect(isClosedStatus('assumption', 'invalid')).toBe(true);
    expect(isClosedStatus('issue', 'in_progress')).toBe(false);
    expect(isClosedStatus('issue', 'resolved')).toBe(true);
    expect(isClosedStatus('dependency', 'at_risk')).toBe(false);
    expect(isClosedStatus('dependency', 'delivered')).toBe(true);
  });

  it('stamps closedAt on entering a closed status, keeps it while closed, clears it on reopening', () => {
    const now = new Date('2026-11-03T10:00:00.000Z');
    const earlier = new Date('2026-10-01T10:00:00.000Z');
    expect(closedAtFor('issue', 'resolved', null, now)).toEqual(now);
    expect(closedAtFor('issue', 'closed', earlier, now)).toEqual(earlier);
    expect(closedAtFor('issue', 'open', earlier, now)).toBeNull();
  });

  it('keeps the closed statuses inside each kind set', () => {
    for (const kind of SCHEMA_KINDS) {
      for (const status of SCHEMA_CLOSED[kind]) expect(SCHEMA_STATUSES[kind]).toContain(status);
    }
  });

  it('is the same vocabulary in the database schema and the shared schemas', () => {
    expect([...schema.RAID_KINDS]).toEqual([...SCHEMA_KINDS]);
    expect(schema.RAID_STATUSES).toEqual(SCHEMA_STATUSES);
    expect(schema.RAID_CLOSED_STATUSES).toEqual(SCHEMA_CLOSED);
    expect([...schema.CONTROL_LINK_TYPES]).toEqual([...CONTROL_LINK_TYPES]);
    expect([...schema.CONTROL_LINK_RELATIONS]).toEqual([...CONTROL_LINK_RELATIONS]);
    expect([...CONTROL_LINK_TYPES]).toEqual([
      'raid_item',
      'task',
      'milestone',
      'decision',
      'change_request',
      'deliverable',
      'benefit',
    ]);
    expect([...CONTROL_LINK_RELATIONS]).toEqual([
      'mitigates',
      'resolves',
      'raised_from',
      'affects',
      'threatens',
      'implements',
      'decided_by',
    ]);
  });

  it('gives an issue the severity of the risk band it came from', () => {
    for (const band of RISK_BANDS) expect(severityForBand(band)).toBe(band);
  });
});

describe('conversion', () => {
  it('turns an assumption into a risk and a risk into an issue, nothing else', () => {
    expect(conversionError('assumption', 'risk')).toBeNull();
    expect(conversionError('risk', 'issue')).toBeNull();
    expect(conversionError('assumption', 'issue')).toBe('An assumption can only be converted to a risk');
    expect(conversionError('risk', 'risk')).toBe('A risk can only be converted to an issue');
    expect(conversionError('issue', 'risk')).toBe('Only assumptions and risks can be converted');
    expect(conversionError('dependency', 'issue')).toBe('Only assumptions and risks can be converted');
  });

  it('closes the source as invalid (assumption) or occurred (risk)', () => {
    expect(sourceStatusAfterConversion('assumption')).toBe('invalid');
    expect(sourceStatusAfterConversion('risk')).toBe('occurred');
    expect(() => sourceStatusAfterConversion('issue')).toThrow(RangeError);
  });
});

describe('field rules', () => {
  it('wants a risk residual pair together', () => {
    expect(raidFieldsError('risk', 'prj_1', { residualProbability: 2, residualImpact: 2 })).toBeNull();
    expect(raidFieldsError('risk', 'prj_1', { residualProbability: 2, residualImpact: null })).toBe(
      'residualProbability and residualImpact must be set together',
    );
  });

  it("wants a party project to go with party type 'project', and never the item's own project", () => {
    expect(raidFieldsError('dependency', 'prj_1', { partyType: 'project', partyProjectId: 'prj_2' })).toBeNull();
    expect(raidFieldsError('dependency', 'prj_1', { partyType: 'supplier', partyProjectId: 'prj_2' })).toBe(
      "partyProjectId requires partyType 'project'",
    );
    expect(raidFieldsError('dependency', 'prj_1', { partyType: 'project', partyProjectId: 'prj_1' })).toBe(
      'A dependency cannot be on its own project',
    );
    expect(raidFieldsError('dependency', 'prj_1', { partyType: 'project', partyProjectId: null })).toBeNull();
  });
});

describe('links', () => {
  const task = { type: 'task', id: 't1' } as const;
  const item = { type: 'raid_item', id: 'r1' } as const;
  const other = { type: 'raid_item', id: 'r2' } as const;
  const milestone = { type: 'milestone', id: 'm1' } as const;

  it('wants two different objects', () => {
    expect(linkShapeError({ from: item, to: item, relation: 'raised_from' })).toBe('A link needs two different objects');
  });

  it('sends mitigates and resolves from a task to a register item', () => {
    expect(linkShapeError({ from: task, to: item, relation: 'mitigates' })).toBeNull();
    expect(linkShapeError({ from: task, to: item, relation: 'resolves' })).toBeNull();
    expect(linkShapeError({ from: item, to: task, relation: 'mitigates' })).toBe(
      "The 'mitigates' relation goes from a task to a register item",
    );
    expect(linkShapeError({ from: task, to: milestone, relation: 'resolves' })).toBe(
      "The 'resolves' relation goes from a task to a register item",
    );
  });

  it('sends raised_from between register items, affects and threatens to a task or milestone', () => {
    expect(linkShapeError({ from: item, to: other, relation: 'raised_from' })).toBeNull();
    expect(linkShapeError({ from: task, to: item, relation: 'raised_from' })).toBe(
      "The 'raised_from' relation goes from a register item to the register item it was raised from",
    );
    expect(linkShapeError({ from: item, to: milestone, relation: 'threatens' })).toBeNull();
    expect(linkShapeError({ from: item, to: task, relation: 'affects' })).toBeNull();
    expect(linkShapeError({ from: item, to: other, relation: 'affects' })).toBe(
      "The 'affects' relation goes from a register item to a task, milestone, deliverable or benefit",
    );
  });

  it('sends affects and threatens on to a deliverable or benefit as well', () => {
    const deliverable = { type: 'deliverable', id: 'd1' } as const;
    const benefit = { type: 'benefit', id: 'b1' } as const;
    const decision = { type: 'decision', id: 'dec1' } as const;
    expect(linkShapeError({ from: item, to: deliverable, relation: 'affects' })).toBeNull();
    expect(linkShapeError({ from: item, to: benefit, relation: 'threatens' })).toBeNull();
    expect(linkShapeError({ from: item, to: decision, relation: 'threatens' })).toBe(
      "The 'threatens' relation goes from a register item to a task, milestone, deliverable or benefit",
    );
  });

  it('sends implements from a task or deliverable to a decision, change request or benefit', () => {
    const deliverable = { type: 'deliverable', id: 'd1' } as const;
    const benefit = { type: 'benefit', id: 'b1' } as const;
    const decision = { type: 'decision', id: 'dec1' } as const;
    const change = { type: 'change_request', id: 'cr1' } as const;
    const message = "The 'implements' relation goes from a task or deliverable to a decision, change request or benefit";
    expect(linkShapeError({ from: task, to: change, relation: 'implements' })).toBeNull();
    expect(linkShapeError({ from: deliverable, to: benefit, relation: 'implements' })).toBeNull();
    expect(linkShapeError({ from: deliverable, to: decision, relation: 'implements' })).toBeNull();
    expect(linkShapeError({ from: item, to: benefit, relation: 'implements' })).toBe(message);
    expect(linkShapeError({ from: task, to: milestone, relation: 'implements' })).toBe(message);
  });

  it('sends decided_by from anything but a decision to a decision', () => {
    const decision = { type: 'decision', id: 'dec1' } as const;
    const change = { type: 'change_request', id: 'cr1' } as const;
    const message = "The 'decided_by' relation goes from an object to the decision that settled it";
    expect(linkShapeError({ from: change, to: decision, relation: 'decided_by' })).toBeNull();
    expect(linkShapeError({ from: item, to: decision, relation: 'decided_by' })).toBeNull();
    expect(linkShapeError({ from: milestone, to: decision, relation: 'decided_by' })).toBeNull();
    expect(linkShapeError({ from: decision, to: { type: 'decision', id: 'dec2' }, relation: 'decided_by' })).toBe(message);
    expect(linkShapeError({ from: item, to: change, relation: 'decided_by' })).toBe(message);
  });

  it('lets a task mitigate only a risk and resolve only an issue', () => {
    const from = { ...task, projectId: 'p1' };
    const risk = { ...item, projectId: 'p1', kind: 'risk' } as const;
    const issue = { ...item, projectId: 'p1', kind: 'issue' } as const;
    expect(linkEndsError({ from, to: risk, relation: 'mitigates' })).toBeNull();
    expect(linkEndsError({ from, to: issue, relation: 'mitigates' })).toBe('A task can only mitigate a risk');
    expect(linkEndsError({ from, to: issue, relation: 'resolves' })).toBeNull();
    expect(linkEndsError({ from, to: risk, relation: 'resolves' })).toBe('A task can only resolve an issue');
  });

  it('keeps both ends in one project, except a dependency on a milestone elsewhere', () => {
    const risk = { ...item, projectId: 'p1', kind: 'risk' } as const;
    const dependency = { ...item, projectId: 'p1', kind: 'dependency' } as const;
    const there = { ...milestone, projectId: 'p2' };
    expect(linkEndsError({ from: risk, to: there, relation: 'threatens' })).toBe(
      'Both ends of a link must be in the same project',
    );
    expect(linkEndsError({ from: dependency, to: there, relation: 'threatens' })).toBeNull();
    expect(linkEndsError({ from: dependency, to: { ...task, projectId: 'p2' }, relation: 'affects' })).toBe(
      'Both ends of a link must be in the same project',
    );
  });
});
