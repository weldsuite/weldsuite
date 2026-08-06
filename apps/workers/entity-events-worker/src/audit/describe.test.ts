import { describe, expect, it } from 'vitest';
import {
  buildDescription,
  getEntityDisplayName,
  stripModulePrefix,
  transformChanges,
} from './describe';

describe('getEntityDisplayName', () => {
  it('reads the first populated name field for the entity type', () => {
    expect(getEntityDisplayName('customer', { name: 'Acme', companyName: 'Acme BV' })).toBe('Acme');
    expect(getEntityDisplayName('customer', { companyName: 'Acme BV' })).toBe('Acme BV');
  });

  it('ignores blank and non-string values', () => {
    expect(getEntityDisplayName('customer', { name: '   ', companyName: 'Acme BV' })).toBe('Acme BV');
    expect(getEntityDisplayName('customer', { name: 42 })).toBeNull();
  });

  it('returns null for an entity type with no configured name field', () => {
    expect(getEntityDisplayName('unmapped_thing', { name: 'Acme' })).toBeNull();
  });
});

describe('stripModulePrefix', () => {
  it('strips a known module prefix', () => {
    expect(stripModulePrefix('project_task')).toBe('task');
    expect(stripModulePrefix('helpdesk_conversation')).toBe('conversation');
  });

  it('leaves unprefixed types alone', () => {
    expect(stripModulePrefix('customer')).toBe('customer');
  });
});

describe('buildDescription', () => {
  it('describes a creation with the entity name and actor', () => {
    expect(buildDescription('created', 'project_task', 'Fix login bug', 'Jane Doe', null)).toBe(
      "'Fix login bug' was created by Jane Doe",
    );
  });

  it('falls back to the humanised type when there is no name', () => {
    expect(buildDescription('created', 'project_task', null, 'Jane Doe', null)).toBe(
      'Task was created by Jane Doe',
    );
  });

  it('falls back to System when there is no actor', () => {
    expect(buildDescription('deleted', 'customer', 'Acme', null, null)).toBe(
      "'Acme' was deleted by System",
    );
  });

  it('lists changed fields on an update', () => {
    expect(buildDescription('updated', 'project_task', 'Fix', 'Jane', ['status'])).toBe(
      'Jane changed Status',
    );
    expect(buildDescription('updated', 'project_task', 'Fix', 'Jane', ['status', 'priority'])).toBe(
      'Jane changed Status and Priority',
    );
    expect(
      buildDescription('updated', 'project_task', 'Fix', 'Jane', ['status', 'priority', 'assigneeId']),
    ).toBe('Jane changed Status, Priority, and Assignee Id');
  });

  it('describes an update with no field list generically', () => {
    expect(buildDescription('updated', 'customer', 'Acme', 'Jane', [])).toBe("Jane updated 'Acme'");
  });

  it('does not double up the past tense', () => {
    expect(buildDescription('archived', 'customer', 'Acme', 'Jane', null)).toContain('was archived');
    expect(buildDescription('completed', 'customer', 'Acme', 'Jane', null)).toContain('was completed');
    // 'approve' → 'approved', not 'approveed'
    expect(buildDescription('approve', 'customer', 'Acme', 'Jane', null)).toContain('was approved');
  });
});

describe('transformChanges', () => {
  it('rewrites old/new into from/to', () => {
    expect(transformChanges({ status: { old: 'open', new: 'closed' } })).toEqual({
      status: { from: 'open', to: 'closed' },
    });
  });

  it('passes undefined through', () => {
    expect(transformChanges(undefined)).toBeUndefined();
  });
});
