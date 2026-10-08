import { describe, expect, it } from 'vitest';
import { makeNexusRow } from '../shared/test-support';
import {
  alertVariant,
  barTone,
  barWidth,
  countByAlert,
  filterNexusRows,
  formatPercent,
  statusVariant,
} from './nexus-model';

describe('barTone', () => {
  it('is neutral below 80%', () => {
    expect(barTone({ percentOfThreshold: 0, registered: false })).toBe('neutral');
    expect(barTone({ percentOfThreshold: 79.99, registered: false })).toBe('neutral');
  });

  it('warns from 80% up to the threshold', () => {
    expect(barTone({ percentOfThreshold: 80, registered: false })).toBe('watch');
    expect(barTone({ percentOfThreshold: 99.99, registered: false })).toBe('watch');
  });

  it('is exceeded at 100% and beyond', () => {
    expect(barTone({ percentOfThreshold: 100, registered: false })).toBe('exceeded');
    expect(barTone({ percentOfThreshold: 340, registered: false })).toBe('exceeded');
  });

  it('is green where the business is registered and near or over the threshold', () => {
    expect(barTone({ percentOfThreshold: 85, registered: true })).toBe('registered');
    expect(barTone({ percentOfThreshold: 250, registered: true })).toBe('registered');
    expect(barTone({ percentOfThreshold: 10, registered: true })).toBe('neutral');
  });
});

describe('barWidth', () => {
  it('fills the bar up to 100%', () => {
    expect(barWidth(42.5)).toBe(42.5);
    expect(barWidth(100)).toBe(100);
    expect(barWidth(340)).toBe(100);
  });

  it('never goes below empty, whatever the number', () => {
    expect(barWidth(-3)).toBe(0);
    expect(barWidth(Number.NaN)).toBe(0);
  });
});

describe('chips', () => {
  it('colors each alert', () => {
    expect(alertVariant('register')).toBe('destructive');
    expect(alertVariant('watch')).toBe('warning');
    expect(alertVariant('registered')).toBe('success');
    expect(alertVariant('ok')).toBe('outline');
  });

  it('does not alarm about a threshold you are registered past', () => {
    expect(statusVariant('exceeded', false)).toBe('destructive');
    expect(statusVariant('exceeded', true)).toBe('secondary');
    expect(statusVariant('approaching', false)).toBe('warning');
    expect(statusVariant('below', false)).toBe('outline');
  });
});

describe('filtering', () => {
  const rows = [
    makeNexusRow({ stateCode: 'CA', stateName: 'California', percentOfThreshold: 130, status: 'exceeded', alert: 'register' }),
    makeNexusRow({ stateCode: 'NY', stateName: 'New York', percentOfThreshold: 90, status: 'approaching', alert: 'watch' }),
    makeNexusRow({ stateCode: 'WA', stateName: 'Washington', percentOfThreshold: 140, status: 'exceeded', alert: 'registered', registered: true }),
    makeNexusRow({ stateCode: 'TX', stateName: 'Texas', percentOfThreshold: 17, alert: 'ok' }),
  ];

  it('keeps the order the server sent when nothing filters', () => {
    expect(filterNexusRows(rows, { alert: 'all', query: '' }).map((row) => row.stateCode)).toEqual(['CA', 'NY', 'WA', 'TX']);
  });

  it('filters by alert', () => {
    expect(filterNexusRows(rows, { alert: 'register', query: '' }).map((row) => row.stateCode)).toEqual(['CA']);
    expect(filterNexusRows(rows, { alert: 'registered', query: '' }).map((row) => row.stateCode)).toEqual(['WA']);
  });

  it('searches the state code and the name, ignoring case', () => {
    expect(filterNexusRows(rows, { alert: 'all', query: 'new' }).map((row) => row.stateCode)).toEqual(['NY']);
    expect(filterNexusRows(rows, { alert: 'all', query: ' tx ' }).map((row) => row.stateCode)).toEqual(['TX']);
  });

  it('combines the alert and the search', () => {
    expect(filterNexusRows(rows, { alert: 'watch', query: 'cal' })).toEqual([]);
  });

  it('counts the states per alert', () => {
    expect(countByAlert(rows)).toEqual({ register: 1, watch: 1, registered: 1, ok: 1 });
  });
});

describe('formatPercent', () => {
  it('drops trailing zeros', () => {
    expect(formatPercent(80)).toBe('80');
    expect(formatPercent(96.5)).toBe('96.5');
    expect(formatPercent(12.3456)).toBe('12.35');
  });
});
