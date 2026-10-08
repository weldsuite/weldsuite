import { describe, it, expect } from 'vitest';
import {
  US_ENTITY_TYPES,
  US_ENTITY_TYPE_INFO,
  allowedTaxClassifications,
  canElectTaxClassification,
  defaultTaxClassification,
  effectiveTaxClassification,
  equityModelFor,
  isUsEntityType,
  isUsTaxClassification,
  isValidTaxClassification,
  taxFormForClassification,
  taxFormForEntity,
} from './entity-types';

describe('entity types', () => {
  it('describes every entity type', () => {
    expect([...US_ENTITY_TYPES].sort()).toEqual(
      ['c_corp', 'multi_member_llc', 'nonprofit', 'partnership', 's_corp', 'single_member_llc', 'sole_proprietorship'],
    );
    for (const type of US_ENTITY_TYPES) {
      const info = US_ENTITY_TYPE_INFO[type];
      expect(info.type).toBe(type);
      expect(info.classifications.length).toBeGreaterThan(0);
      // entities.entity_type is varchar(20)
      expect(type.length).toBeLessThanOrEqual(20);
    }
  });

  it('lets only an LLC choose its tax classification', () => {
    expect(allowedTaxClassifications('single_member_llc')).toEqual(['disregarded', 's_corp', 'c_corp']);
    expect(allowedTaxClassifications('multi_member_llc')).toEqual(['partnership', 's_corp', 'c_corp']);
    expect(canElectTaxClassification('single_member_llc')).toBe(true);
    expect(canElectTaxClassification('multi_member_llc')).toBe(true);
    for (const type of ['sole_proprietorship', 'partnership', 's_corp', 'c_corp', 'nonprofit']) {
      expect(canElectTaxClassification(type), type).toBe(false);
    }
    expect(allowedTaxClassifications('banana')).toEqual([]);
    expect(allowedTaxClassifications(null)).toEqual([]);
  });

  it('defaults an LLC to disregarded or partnership', () => {
    expect(defaultTaxClassification('sole_proprietorship')).toBe('sole_proprietor');
    expect(defaultTaxClassification('single_member_llc')).toBe('disregarded');
    expect(defaultTaxClassification('multi_member_llc')).toBe('partnership');
    expect(defaultTaxClassification('partnership')).toBe('partnership');
    expect(defaultTaxClassification('s_corp')).toBe('s_corp');
    expect(defaultTaxClassification('c_corp')).toBe('c_corp');
    expect(defaultTaxClassification('nonprofit')).toBe('exempt');
    expect(defaultTaxClassification(undefined)).toBe('sole_proprietor');
  });

  it('validates a type and classification pair', () => {
    expect(isValidTaxClassification('single_member_llc', 's_corp')).toBe(true);
    expect(isValidTaxClassification('single_member_llc', 'partnership')).toBe(false);
    expect(isValidTaxClassification('s_corp', 'c_corp')).toBe(false);
    expect(isValidTaxClassification('s_corp', null)).toBe(false);
    expect(isUsEntityType('s_corp')).toBe(true);
    expect(isUsEntityType('bv')).toBe(false);
    expect(isUsTaxClassification('exempt')).toBe(true);
    expect(isUsTaxClassification('llc')).toBe(false);
  });
});

describe('taxFormForEntity', () => {
  it.each([
    ['sole_proprietorship', undefined, 'sch_c'],
    ['sole_proprietorship', 'sole_proprietor', 'sch_c'],
    ['single_member_llc', 'disregarded', 'sch_c'],
    ['single_member_llc', null, 'sch_c'],
    ['single_member_llc', 's_corp', 'f1120s'],
    ['single_member_llc', 'c_corp', 'f1120'],
    ['multi_member_llc', 'partnership', 'f1065'],
    ['multi_member_llc', undefined, 'f1065'],
    ['multi_member_llc', 's_corp', 'f1120s'],
    ['multi_member_llc', 'c_corp', 'f1120'],
    ['partnership', 'partnership', 'f1065'],
    ['s_corp', 's_corp', 'f1120s'],
    ['c_corp', 'c_corp', 'f1120'],
    ['nonprofit', 'exempt', 'f990'],
    ['nonprofit', undefined, 'f990'],
  ] as const)('%s + %s files %s', (entityType, classification, form) => {
    expect(taxFormForEntity(entityType, classification)).toBe(form);
  });

  it('ignores a classification the entity type does not allow', () => {
    expect(taxFormForEntity('s_corp', 'c_corp')).toBe('f1120s');
    expect(taxFormForEntity('single_member_llc', 'partnership')).toBe('sch_c');
    expect(effectiveTaxClassification('partnership', 's_corp')).toBe('partnership');
  });

  it('falls back to Schedule C without an entity type, and trusts a lone classification', () => {
    expect(taxFormForEntity(null)).toBe('sch_c');
    expect(taxFormForEntity(undefined, undefined)).toBe('sch_c');
    expect(taxFormForEntity('bv', null)).toBe('sch_c');
    expect(taxFormForEntity(null, 's_corp')).toBe('f1120s');
  });

  it('maps each classification to a form', () => {
    expect(taxFormForClassification('sole_proprietor')).toBe('sch_c');
    expect(taxFormForClassification('disregarded')).toBe('sch_c');
    expect(taxFormForClassification('partnership')).toBe('f1065');
    expect(taxFormForClassification('s_corp')).toBe('f1120s');
    expect(taxFormForClassification('c_corp')).toBe('f1120');
    expect(taxFormForClassification('exempt')).toBe('f990');
  });
});

describe('equityModelFor', () => {
  it('follows the tax classification, not the legal form', () => {
    expect(equityModelFor('sole_proprietorship')).toBe('sole_proprietor');
    expect(equityModelFor('single_member_llc', 'disregarded')).toBe('sole_proprietor');
    expect(equityModelFor('single_member_llc', 's_corp')).toBe('s_corp');
    expect(equityModelFor('multi_member_llc')).toBe('partnership');
    expect(equityModelFor('multi_member_llc', 'c_corp')).toBe('c_corp');
    expect(equityModelFor('partnership')).toBe('partnership');
    expect(equityModelFor('s_corp')).toBe('s_corp');
    expect(equityModelFor('c_corp')).toBe('c_corp');
    expect(equityModelFor('nonprofit')).toBe('nonprofit');
    expect(equityModelFor(undefined)).toBe('sole_proprietor');
  });
});
