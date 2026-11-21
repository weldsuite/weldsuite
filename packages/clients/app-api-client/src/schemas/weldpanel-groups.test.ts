import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import {
  createPanelGroupTypeSchema,
  PANEL_MAX_GROUP_KEY,
  panelGroupDeleteQuerySchema,
  panelGroupKeySchema,
  panelGroupListQuerySchema,
  panelGroupMatchPropertySchema,
  panelGroupProfileQuerySchema,
  panelGroupTypeListQuerySchema,
  updatePanelGroupTypeSchema,
} from './weldpanel-groups';

/** The issues a parse reports, as `path: message`. Empty when it parses. */
function issuesOf(schema: ZodTypeAny, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

const projectId = 'pnp_1';

describe('group keys', () => {
  it('takes any printable text up to the collector limit', () => {
    expect(panelGroupKeySchema.parse('acme')).toBe('acme');
    expect(panelGroupKeySchema.parse('Acme Inc. / EU ✓')).toBe('Acme Inc. / EU ✓');
    expect(panelGroupKeySchema.safeParse('k'.repeat(PANEL_MAX_GROUP_KEY)).success).toBe(true);
    expect(panelGroupKeySchema.safeParse('k'.repeat(PANEL_MAX_GROUP_KEY + 1)).success).toBe(false);
    expect(panelGroupKeySchema.safeParse('').success).toBe(false);
  });

  it('refuses control characters', () => {
    expect(issuesOf(panelGroupKeySchema, 'acme\tinc')).toEqual([': Not a valid group key']);
    expect(issuesOf(panelGroupKeySchema, 'acme\u007f')).toEqual([': Not a valid group key']);
  });
});

describe('CRM match properties', () => {
  it('takes plain and $-prefixed property keys, trimmed', () => {
    expect(panelGroupMatchPropertySchema.parse(' domain ')).toBe('domain');
    expect(panelGroupMatchPropertySchema.parse('$name')).toBe('$name');
    expect(issuesOf(panelGroupMatchPropertySchema, '1domain')).toEqual([': Not a valid property key']);
  });
});

describe('group types', () => {
  it('creates a type with its names and an optional CRM match', () => {
    expect(
      createPanelGroupTypeSchema.parse({ projectId, groupType: 'company', nameSingular: ' Company ', namePlural: 'Companies', crmMatchProperty: 'domain' }),
    ).toEqual({ projectId, groupType: 'company', nameSingular: 'Company', namePlural: 'Companies', crmMatchProperty: 'domain' });
    expect(createPanelGroupTypeSchema.safeParse({ projectId, groupType: 'Company', nameSingular: 'Company', namePlural: 'Companies' }).success).toBe(false);
  });

  it('changes at least the names or the CRM match, and clears the match with null', () => {
    expect(issuesOf(updatePanelGroupTypeSchema, {})).toEqual([': Nothing to change']);
    expect(updatePanelGroupTypeSchema.parse({ crmMatchProperty: null })).toEqual({ crmMatchProperty: null });
    expect(updatePanelGroupTypeSchema.parse({ namePlural: 'Accounts' })).toEqual({ namePlural: 'Accounts' });
    expect(updatePanelGroupTypeSchema.parse({ nameSingular: 'Account' })).toEqual({ nameSingular: 'Account' });
  });

  it('lists the types of a project', () => {
    expect(panelGroupTypeListQuerySchema.parse({ projectId })).toEqual({ projectId });
    expect(panelGroupTypeListQuerySchema.safeParse({}).success).toBe(false);
  });
});

describe('group queries', () => {
  it('lists 50 groups by default and reads the limit from the query string', () => {
    expect(panelGroupListQuerySchema.parse({ projectId, type: 'company' })).toEqual({ projectId, type: 'company', limit: 50 });
    expect(panelGroupListQuerySchema.parse({ projectId, type: 'company', limit: '20', search: ' acme ', cursor: null })).toEqual({
      projectId,
      type: 'company',
      limit: 20,
      search: 'acme',
      cursor: null,
    });
    expect(panelGroupListQuerySchema.safeParse({ projectId, type: 'company', limit: '0' }).success).toBe(false);
  });

  it('reads a profile over 90 days by default, and 7 to 365 days when asked', () => {
    expect(panelGroupProfileQuerySchema.parse({ projectId })).toEqual({ projectId, days: 90 });
    expect(panelGroupProfileQuerySchema.parse({ projectId, days: '30' })).toEqual({ projectId, days: 30 });
    expect(panelGroupProfileQuerySchema.safeParse({ projectId, days: '6' }).success).toBe(false);
    expect(panelGroupProfileQuerySchema.safeParse({ projectId, days: '366' }).success).toBe(false);
  });

  it('deletes a group of a project', () => {
    expect(panelGroupDeleteQuerySchema.parse({ projectId })).toEqual({ projectId });
  });
});
