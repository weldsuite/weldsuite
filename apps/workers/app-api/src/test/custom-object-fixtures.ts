/**
 * Seed data for the WeldObjects record, relationship and reverse-lookup
 * tests: two objects (`asset` with every field type, `site` with events
 * off), a disabled one, records with values, relationships of every
 * cardinality and delete rule, and the companies they point at.
 */

import { schema, type Database } from '@weldsuite/worker-kit/db';

const day = (n: number) => new Date(`2026-06-${String(n).padStart(2, '0')}T09:00:00.000Z`);

export const OWNER = 'user_test_default';
export const OTHER = 'user_other';

const field = (
  id: string,
  entityType: string,
  slug: string,
  fieldType: string,
  sortOrder: number,
  extra: Partial<typeof schema.customFieldDefinitions.$inferInsert> = {},
) => ({
  id,
  entityType,
  name: slug,
  slug,
  fieldType,
  sortOrder,
  createdAt: day(1),
  updatedAt: day(1),
  ...extra,
});

const record = (
  id: string,
  entityKey: string,
  title: string | null,
  ownerId: string,
  created: number,
  updated: number,
  extra: Partial<typeof schema.customObjectRecords.$inferInsert> = {},
) => ({
  id,
  objectId: entityKey === 'co_asset' ? 'cobj_asset' : 'cobj_site',
  entityKey,
  title,
  ownerId,
  createdBy: ownerId,
  updatedBy: ownerId,
  createdAt: day(created),
  updatedAt: day(updated),
  ...extra,
});

let n = 0;
const value = (fieldId: string, entityType: string, entityId: string, columns: Partial<typeof schema.customFieldValues.$inferInsert>) => ({
  id: `cfv_fx_${++n}`,
  fieldId,
  entityType,
  entityId,
  createdAt: day(1),
  updatedAt: day(1),
  ...columns,
});

const link = (
  id: string,
  slug: string,
  sourceEntityKey: string,
  targetEntityKey: string,
  cardinality: string,
  sourceLabel: string,
  targetLabel: string,
  onDelete = 'set_null',
) => ({ id, slug, sourceEntityKey, targetEntityKey, cardinality, sourceLabel, targetLabel, onDelete, createdAt: day(1), updatedAt: day(1) });

const edge = (id: string, linkId: string, sourceEntityKey: string, sourceId: string, targetEntityKey: string, targetId: string, created: number) => ({
  id,
  linkId,
  sourceEntityKey,
  sourceId,
  targetEntityKey,
  targetId,
  createdAt: day(created),
});

export async function seedCustomObjects(db: Database): Promise<void> {
  await db.insert(schema.customObjects).values([
    { id: 'cobj_asset', slug: 'asset', entityKey: 'co_asset', labelSingular: 'Asset', labelPlural: 'Assets', status: 'active', titleFieldId: 'cfld_as_name', createdAt: day(1), updatedAt: day(1) },
    { id: 'cobj_site', slug: 'site', entityKey: 'co_site', labelSingular: 'Site', labelPlural: 'Sites', status: 'active', enableEvents: false, createdAt: day(1), updatedAt: day(1) },
    { id: 'cobj_gadget', slug: 'gadget', entityKey: 'co_gadget', labelSingular: 'Gadget', labelPlural: 'Gadgets', status: 'disabled', createdAt: day(1), updatedAt: day(1) },
  ]);

  await db.insert(schema.customFieldDefinitions).values([
    field('cfld_as_name', 'co_asset', 'name', 'text', 0, { required: true }),
    field('cfld_as_serial', 'co_asset', 'serial', 'text', 1),
    field('cfld_as_power', 'co_asset', 'power', 'number', 2),
    field('cfld_as_installed', 'co_asset', 'installed', 'date', 3),
    field('cfld_as_active', 'co_asset', 'active', 'boolean', 4),
    field('cfld_as_tier', 'co_asset', 'tier', 'single_select', 5, {
      options: [
        { label: 'Gold', value: 'gold' },
        { label: 'Silver', value: 'silver' },
      ],
    }),
    field('cfld_as_tags', 'co_asset', 'tags', 'multi_select', 6, {
      options: [
        { label: 'Red', value: 'red' },
        { label: 'Blue', value: 'blue' },
        { label: 'Green', value: 'green' },
      ],
    }),
    field('cfld_as_tech', 'co_asset', 'tech', 'user_ref', 7),
    field('cfld_as_manual', 'co_asset', 'manual', 'file', 8),
    field('cfld_as_rating', 'co_asset', 'rating', 'rating', 9),
    field('cfld_as_gone', 'co_asset', 'gone', 'text', 10, { deletedAt: day(2) }),
    field('cfld_site_label', 'co_site', 'label', 'text', 0),
  ]);

  await db.insert(schema.customObjectRecords).values([
    record('cor_as_1', 'co_asset', 'Alpha press', OWNER, 1, 5),
    record('cor_as_2', 'co_asset', 'Beta 50% lathe', OTHER, 2, 3),
    record('cor_as_3', 'co_asset', null, OWNER, 3, 4),
    record('cor_as_4', 'co_asset', 'Gamma', OWNER, 4, 1),
    record('cor_as_dead', 'co_asset', 'Dead', OWNER, 5, 5, { deletedAt: day(6) }),
    record('cor_site_1', 'co_site', 'North', OWNER, 1, 1),
    record('cor_site_2', 'co_site', 'South', OWNER, 2, 2),
  ]);

  await db.insert(schema.customFieldValues).values([
    value('cfld_as_name', 'co_asset', 'cor_as_1', { valueText: 'Alpha press' }),
    value('cfld_as_serial', 'co_asset', 'cor_as_1', { valueText: 'AB-100' }),
    value('cfld_as_power', 'co_asset', 'cor_as_1', { valueNumber: 5 }),
    value('cfld_as_installed', 'co_asset', 'cor_as_1', { valueDate: new Date('2026-01-02T10:00:00.000Z') }),
    value('cfld_as_active', 'co_asset', 'cor_as_1', { valueBool: true }),
    value('cfld_as_tier', 'co_asset', 'cor_as_1', { valueText: 'gold' }),
    value('cfld_as_tags', 'co_asset', 'cor_as_1', { valueJson: ['red', 'blue'] }),
    value('cfld_as_tech', 'co_asset', 'cor_as_1', { valueRef: 'user_x' }),
    value('cfld_as_gone', 'co_asset', 'cor_as_1', { valueText: 'inert' }),
    value('cfld_as_name', 'co_asset', 'cor_as_2', { valueText: 'Beta 50% lathe' }),
    value('cfld_as_serial', 'co_asset', 'cor_as_2', { valueText: 'XY-200' }),
    value('cfld_as_power', 'co_asset', 'cor_as_2', { valueNumber: 12.5 }),
    value('cfld_as_installed', 'co_asset', 'cor_as_2', { valueDate: new Date('2026-02-01T00:00:00.000Z') }),
    value('cfld_as_active', 'co_asset', 'cor_as_2', { valueBool: false }),
    value('cfld_as_tags', 'co_asset', 'cor_as_2', { valueJson: ['green'] }),
    value('cfld_as_serial', 'co_asset', 'cor_as_3', { valueText: 'ab-300' }),
    value('cfld_as_name', 'co_asset', 'cor_as_4', { valueText: 'Gamma' }),
    value('cfld_as_power', 'co_asset', 'cor_as_4', { valueNumber: 5 }),
    value('cfld_as_manual', 'co_asset', 'cor_as_4', { valueJson: { url: 'https://files.example/manual.pdf', size: 1200 } }),
    value('cfld_site_label', 'co_site', 'cor_site_1', { valueText: 'North' }),
    value('cfld_site_label', 'co_site', 'cor_site_2', { valueText: 'South' }),
  ]);

  await db.insert(schema.customObjectLinks).values([
    link('colk_as_customer', 'customer', 'co_asset', 'company', 'many_to_one', 'Assets', 'Customer'),
    link('colk_as_sites', 'sites', 'co_asset', 'co_site', 'many_to_many', 'Assets', 'Sites'),
    link('colk_as_primary', 'primary_site', 'co_asset', 'co_site', 'one_to_one', 'Primary assets', 'Primary site'),
    link('colk_as_ticket', 'ticket', 'co_asset', 'ticket', 'many_to_many', 'Assets', 'Ticket'),
    link('colk_site_anchor', 'anchor', 'co_site', 'co_asset', 'many_to_one', 'Anchored sites', 'Anchor', 'restrict'),
    link('colk_site_parent', 'parent', 'co_site', 'co_asset', 'many_to_one', 'Child sites', 'Parent', 'cascade'),
    link('colk_site_company', 'company', 'co_site', 'company', 'many_to_one', 'Sites', 'Company'),
  ]);

  await db.insert(schema.customObjectRelations).values([
    edge('corl_fx_1', 'colk_as_customer', 'co_asset', 'cor_as_1', 'company', 'comp_fx_1', 1),
    edge('corl_fx_2', 'colk_as_sites', 'co_asset', 'cor_as_1', 'co_site', 'cor_site_2', 2),
    edge('corl_fx_3', 'colk_as_sites', 'co_asset', 'cor_as_1', 'co_site', 'cor_site_1', 3),
    edge('corl_fx_4', 'colk_as_ticket', 'co_asset', 'cor_as_1', 'ticket', 'tkt_missing', 3),
    edge('corl_fx_5', 'colk_site_anchor', 'co_site', 'cor_site_1', 'co_asset', 'cor_as_4', 4),
    edge('corl_fx_6', 'colk_site_parent', 'co_site', 'cor_site_2', 'co_asset', 'cor_as_3', 4),
    edge('corl_fx_7', 'colk_site_company', 'co_site', 'cor_site_1', 'company', 'comp_fx_1', 5),
    edge('corl_fx_8', 'colk_as_customer', 'co_asset', 'cor_as_dead', 'company', 'comp_fx_1', 5),
  ]);

  await db.insert(schema.companies).values([
    { id: 'comp_fx_1', name: 'Acme', displayName: 'Acme Inc', createdAt: day(1), updatedAt: day(1) },
    { id: 'comp_fx_2', name: '', displayName: 'Blank Co', createdAt: day(1), updatedAt: day(1) },
  ] as (typeof schema.companies.$inferInsert)[]);
}
