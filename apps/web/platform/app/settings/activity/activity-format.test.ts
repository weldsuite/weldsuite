import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import {
  actionLabel,
  actionPhrase,
  createQuietTranslator,
  dayBounds,
  describeActivity,
  entityTypeLabel,
  humanizeKey,
  recordHref,
  recordName,
} from './activity-format';

const tr = createQuietTranslator(en);

describe('labels', () => {
  it('uses current product names for entity types', () => {
    expect(entityTypeLabel('opportunity', tr)).toBe('Deal');
    expect(entityTypeLabel('customer', tr)).toBe('Company');
    expect(entityTypeLabel('project_task', tr)).toBe('Task');
    expect(entityTypeLabel('vat_return', tr)).toBe('VAT return');
    expect(entityTypeLabel('accounting_contact', tr)).toBe('Contact (WeldBooks)');
  });

  it('humanises an entity type without a translation', () => {
    expect(entityTypeLabel('wms_cycle_count', tr)).toBe('Cycle count');
    expect(entityTypeLabel('something_new', tr)).toBe('Something new');
  });

  it('translates actions and falls back to a humanised key', () => {
    expect(actionLabel('stage_changed', tr)).toBe('Stage changed');
    expect(actionLabel('won', tr)).toBe('Won');
    expect(actionLabel('brand_new_action', tr)).toBe('Brand new action');
    expect(actionPhrase('won', tr)).toBe('marked as won');
    expect(actionPhrase('stage_changed', tr)).toBe('moved to another stage');
    expect(actionPhrase('brand_new_action', tr)).toBe('brand new action');
    expect(humanizeKey('periodLabel')).toBe('Period label');
  });
});

describe('describeActivity', () => {
  const base = { entityType: 'opportunity', performedByName: 'Jane', metadata: { translationParams: { entityName: 'Zeta renewal deal' } } };

  it('never builds "woned" / "stage_changeded"', () => {
    expect(describeActivity({ ...base, action: 'won' }, tr)).toBe("'Zeta renewal deal' was marked as won by Jane");
    expect(describeActivity({ ...base, action: 'stage_changed' }, tr)).toBe(
      "'Zeta renewal deal' was moved to another stage by Jane",
    );
  });

  it('describes field changes and falls back to the entity type and System', () => {
    expect(
      describeActivity(
        { action: 'updated', entityType: 'vat_return', changes: { status: { from: 'a', to: 'b' }, periodLabel: { from: 1, to: 2 } } },
        tr,
      ),
    ).toBe('System changed Status and Period label on VAT return');
    expect(describeActivity({ action: 'updated', entityType: 'company', performedByName: 'Bob', data: { name: 'Acme' } }, tr)).toBe(
      "Bob updated 'Acme'",
    );
  });

  it('renders Dutch', async () => {
    const { nl } = await import('@weldsuite/i18n/locales/nl');
    const trNl = createQuietTranslator(nl);
    expect(describeActivity({ ...base, action: 'lost' }, trNl)).toBe("'Zeta renewal deal' is als verloren gemarkeerd door Jane");
    expect(entityTypeLabel('opportunity', trNl)).toBe('Deal');
  });
});

describe('recordName', () => {
  it('prefers the name the writer resolved, then the data snapshot', () => {
    expect(recordName({ metadata: { translationParams: { entityName: 'Acme' } }, data: { name: 'Other' } })).toBe('Acme');
    expect(recordName({ data: { firstName: 'Jane', lastName: 'Doe' } })).toBe('Jane Doe');
    expect(recordName({ data: { periodLabel: 'Q3 2026' } })).toBe('Q3 2026');
    expect(recordName({ data: { name: 'Negotiation' } })).toBe('Negotiation');
    expect(recordName({ data: { title: 'Weekly sync' } })).toBe('Weekly sync');
    expect(recordName({ data: { id: 'x', status: 'draft' } })).toBeNull();
  });
});

describe('recordHref', () => {
  it('links the types with a URL and nothing else', () => {
    expect(recordHref('company', 'cmp_1')).toBe('/weldcrm/companies?stack=company:cmp_1:panel');
    expect(recordHref('contact', 'per_1')).toBe('/weldcrm/people?stack=person:per_1:panel');
    expect(recordHref('project_task', 'tsk_1')).toBe('/weldflow/task/tsk_1');
    expect(recordHref('vat_return', 'vat_1')).toBeNull();
  });
});

describe('dayBounds', () => {
  it('covers the whole local day', () => {
    const bounds = dayBounds('2026-10-07')!;
    expect(new Date(bounds.start).getDate()).toBe(7);
    expect(new Date(bounds.end).getHours()).toBe(23);
    expect(dayBounds('nope')).toBeNull();
  });
});
