/**
 * Unit tests for the AI workflow-generation post-validation — pure logic, no
 * DB or AI call. Guards the id/name normalization and the "flag, don't drop"
 * behavior for anything referencing an unknown action/trigger type.
 */

import { describe, it, expect } from 'vitest';
import { postValidateDraft, buildValidationCatalog, type ValidationCatalog } from './workflow-generation';

function catalog(overrides: Partial<ValidationCatalog> = {}): ValidationCatalog {
  return {
    actionTypeIds: new Set(['send_email', 'condition', 'ai_generate']),
    entityEventsByType: new Map([
      ['ticket', new Set(['created', 'updated', 'closed'])],
      ['lead', new Set(['created', 'qualified'])],
    ]),
    ...overrides,
  };
}

describe('postValidateDraft', () => {
  it('normalizes a well-formed draft without warnings', () => {
    const { workflow, warnings } = postValidateDraft(
      {
        name: 'Welcome new leads',
        description: 'Email new leads when they arrive',
        triggers: [{ type: 'entity_event', name: 'Lead created', config: { entityType: 'lead', eventType: 'created' } }],
        steps: [{ type: 'send_email', name: 'Send welcome email', config: { to: '{{trigger.email}}', subject: 'Hi', body: 'Welcome!' } }],
      },
      catalog(),
    );

    expect(warnings).toEqual([]);
    expect(workflow.name).toBe('Welcome new leads');
    expect(workflow.triggers).toHaveLength(1);
    expect(workflow.triggers[0].id).toMatch(/^trg_/);
    expect(workflow.triggers[0].isEnabled).toBe(true);
    expect(workflow.steps).toHaveLength(1);
    expect(workflow.steps[0].id).toMatch(/^step_/);
  });

  it('assigns stable ids/names when the model omits them', () => {
    const { workflow } = postValidateDraft(
      {
        name: 'X',
        triggers: [{ type: 'manual' } as never],
        steps: [{ type: 'log' } as never],
      },
      catalog(),
    );
    expect(workflow.triggers[0].name).toBe('Trigger 1');
    expect(workflow.steps[0].name).toBe('Step 1');
  });

  it('flags (does not drop) a step with an unknown action type', () => {
    const { workflow, warnings } = postValidateDraft(
      {
        name: 'X',
        triggers: [{ type: 'manual', name: 'Manual' }],
        steps: [{ type: 'totally_made_up_action', name: 'Mystery step' }],
      },
      catalog(),
    );
    expect(workflow.steps).toHaveLength(1);
    expect(workflow.steps[0].type).toBe('totally_made_up_action');
    expect(warnings.some((w) => w.includes('Mystery step') && w.includes('unknown action type'))).toBe(true);
  });

  it('flags an unknown trigger category', () => {
    const { warnings } = postValidateDraft(
      {
        name: 'X',
        triggers: [{ type: 'not_a_real_category', name: 'Weird trigger' }],
        steps: [{ type: 'send_email', name: 'Step' }],
      },
      catalog(),
    );
    expect(warnings.some((w) => w.includes('Weird trigger') && w.includes('unknown trigger type'))).toBe(true);
  });

  it('flags an entity_event trigger with an unknown entityType', () => {
    const { warnings } = postValidateDraft(
      {
        name: 'X',
        triggers: [{ type: 'entity_event', name: 'Bad entity', config: { entityType: 'unicorn', eventType: 'created' } }],
        steps: [{ type: 'send_email', name: 'Step' }],
      },
      catalog(),
    );
    expect(warnings.some((w) => w.includes('Bad entity') && w.includes('unknown entity type'))).toBe(true);
  });

  it('flags an entity_event trigger with a valid entityType but unknown eventType', () => {
    const { warnings } = postValidateDraft(
      {
        name: 'X',
        triggers: [{ type: 'entity_event', name: 'Bad event', config: { entityType: 'ticket', eventType: 'teleported' } }],
        steps: [{ type: 'send_email', name: 'Step' }],
      },
      catalog(),
    );
    expect(warnings.some((w) => w.includes('Bad event') && w.includes('unknown event'))).toBe(true);
  });

  it('accepts a valid entity_event entityType/eventType pair without warnings', () => {
    const { warnings } = postValidateDraft(
      {
        name: 'X',
        triggers: [{ type: 'entity_event', name: 'Ticket closed', config: { entityType: 'ticket', eventType: 'closed' } }],
        steps: [{ type: 'send_email', name: 'Step' }],
      },
      catalog(),
    );
    expect(warnings).toEqual([]);
  });

  it('warns when there are no steps or no triggers', () => {
    const { warnings } = postValidateDraft({ name: 'X', triggers: [], steps: [] }, catalog());
    expect(warnings.some((w) => w.includes('no steps'))).toBe(true);
    expect(warnings.some((w) => w.includes('no trigger'))).toBe(true);
  });

  it('falls back to "Untitled workflow" when the model omits a name', () => {
    const { workflow } = postValidateDraft({ triggers: [], steps: [] }, catalog());
    expect(workflow.name).toBe('Untitled workflow');
  });
});

describe('buildValidationCatalog', () => {
  it('builds a non-empty catalog from the real static catalogs', () => {
    const catalog = buildValidationCatalog();
    expect(catalog.actionTypeIds.size).toBeGreaterThan(0);
    expect(catalog.actionTypeIds.has('ai_generate')).toBe(true);
    expect(catalog.actionTypeIds.has('send_email')).toBe(true);
    expect(catalog.entityEventsByType.size).toBeGreaterThan(0);
  });
});
