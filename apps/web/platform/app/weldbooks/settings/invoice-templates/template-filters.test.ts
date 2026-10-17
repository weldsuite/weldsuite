import { describe, expect, it } from 'vitest';
import type { InvoiceTemplate } from '@weldsuite/books-domain/invoice-template/schema';
import { applyTemplateFilters } from './template-filters';

const template = (id: string, paperSize: 'a4' | 'letter', isDefault: boolean) =>
  ({ id, name: id, isDefault, document: { paperSize } }) as unknown as InvoiceTemplate;

const items = [template('a4-default', 'a4', true), template('a4-other', 'a4', false), template('letter', 'letter', false)];
const ids = (list: InvoiceTemplate[]) => list.map((t) => t.id);
const filter = (field: string, operator: string, value: string) => ({ id: field, field, operator, value });

describe('applyTemplateFilters', () => {
  it('filters on paper size', () => {
    expect(ids(applyTemplateFilters(items, [filter('paperSize', 'is', 'letter')]))).toEqual(['letter']);
    expect(ids(applyTemplateFilters(items, [filter('paperSize', 'is not', 'letter')]))).toEqual(['a4-default', 'a4-other']);
  });

  it('filters on being the default', () => {
    expect(ids(applyTemplateFilters(items, [filter('default', 'is', 'yes')]))).toEqual(['a4-default']);
    expect(ids(applyTemplateFilters(items, [filter('default', 'is', 'no')]))).toEqual(['a4-other', 'letter']);
  });

  it('combines filters and ignores ones without a value yet', () => {
    expect(ids(applyTemplateFilters(items, [filter('paperSize', 'is', 'a4'), filter('default', 'is', 'no')]))).toEqual(['a4-other']);
    expect(ids(applyTemplateFilters(items, [filter('paperSize', '', '')]))).toEqual(ids(items));
  });
});
