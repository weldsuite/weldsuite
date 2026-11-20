import { describe, expect, it } from 'vitest';
import type { RecordingsSearch } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { ActiveFilter } from '@/components/panel-entity-list';
import { filtersToSearch, searchToFilters } from './filter-pills';

const pill = (field: string, operator: string, value: string): ActiveFilter => ({ id: `${field}:${operator}:${value}`, field, operator, value });

describe('recordings filter pills', () => {
  it('turn every filter of a search into pills and back', () => {
    const search: RecordingsSearch = {
      range: '7d',
      devices: ['mobile'],
      countries: ['NL'],
      browsers: ['Safari'],
      frustration: ['rage'],
      errors: true,
      favorites: true,
      cohort: 'coh_1',
      did: ['Checkout started'],
      didNot: ['Paid'],
      entryPage: '/pricing',
      exitPage: '/signup',
      pages: ['/features/crm'],
      minDuration: 30,
      maxDuration: 600,
    };
    expect(filtersToSearch(searchToFilters(search), {})).toEqual(search);
  });

  it('keep the person, sort and project, which are not pills', () => {
    expect(filtersToSearch([pill('errors', 'is', 'true')], { user: 'user_42', sort: 'duration_desc', project: 'wpp_1', errors: false })).toEqual({
      user: 'user_42',
      sort: 'duration_desc',
      project: 'wpp_1',
      errors: true,
    });
  });

  it('carry a custom period from a link as one pill', () => {
    const pills = searchToFilters({ from: '2026-11-01', to: '2026-11-07' });
    expect(pills).toEqual([pill('period', 'is', '2026-11-01..2026-11-07')]);
    expect(filtersToSearch(pills, {})).toEqual({ from: '2026-11-01', to: '2026-11-07' });
  });

  it('read "device is not" as every other device', () => {
    expect(filtersToSearch([pill('device', 'is not', 'mobile')], {}).devices).toEqual(['desktop', 'tablet']);
    expect(filtersToSearch([pill('device', 'is', 'mobile'), pill('device', 'is', 'tablet'), pill('device', 'is not', 'tablet')], {}).devices).toEqual(['mobile']);
  });

  it('ignore pills that are still being filled in, and durations that are not numbers', () => {
    expect(filtersToSearch([pill('country', '', ''), pill('minDuration', 'gt', 'abc')], {})).toEqual({});
  });
});
