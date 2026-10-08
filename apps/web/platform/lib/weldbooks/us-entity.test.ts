import { describe, expect, it } from 'vitest';
import {
  classificationsOf,
  defaultClassificationOf,
  defaultUsTimeZone,
  einProblem,
  formatEinInput,
  formatSsnInput,
  maskedSsn,
  normalizeEin,
  normalizeSsn,
  ssnProblem,
  timeZoneOptions,
  US_TIME_ZONES,
  validClassification,
  type UsEntityTypeSummary,
} from './us-entity';

const types: UsEntityTypeSummary[] = [
  {
    type: 'single_member_llc',
    label: 'LLC with one member',
    description: '',
    minOwners: 1,
    defaultClassification: 'disregarded',
    classifications: [
      { value: 'disregarded', form: 'sch_c', formLabel: 'Schedule C (Form 1040)' },
      { value: 's_corp', form: 'f1120s', formLabel: 'Form 1120-S' },
    ],
  },
  {
    type: 'c_corp',
    label: 'C corporation',
    description: '',
    minOwners: 1,
    defaultClassification: 'c_corp',
    classifications: [{ value: 'c_corp', form: 'f1120', formLabel: 'Form 1120' }],
  },
];

describe('tax classification of an entity type', () => {
  it('lists the classifications a type allows and its default', () => {
    expect(classificationsOf(types, 'single_member_llc').map((c) => c.value)).toEqual(['disregarded', 's_corp']);
    expect(defaultClassificationOf(types, 'single_member_llc')).toBe('disregarded');
    expect(classificationsOf(types, 'unknown')).toEqual([]);
    expect(classificationsOf(undefined, 'c_corp')).toEqual([]);
  });

  it('keeps a classification the type allows and falls back to the default otherwise', () => {
    expect(validClassification(types, 'single_member_llc', 's_corp')).toBe('s_corp');
    expect(validClassification(types, 'c_corp', 's_corp')).toBe('c_corp');
    expect(validClassification(types, 'single_member_llc', '')).toBe('disregarded');
    expect(validClassification(types, 'unknown', 's_corp')).toBe('');
  });
});

describe('EIN', () => {
  it('formats while typing', () => {
    expect(formatEinInput('1')).toBe('1');
    expect(formatEinInput('123')).toBe('12-3');
    expect(formatEinInput('12-3456789')).toBe('12-3456789');
    expect(formatEinInput('1234567890123')).toBe('12-3456789');
    expect(formatEinInput('ab12cd34')).toBe('12-34');
  });

  it('accepts the format and the prefixes the IRS assigns, empty included', () => {
    expect(einProblem('')).toBeNull();
    expect(einProblem('12-3456789')).toBeNull();
    expect(einProblem('123456789')).toBeNull();
    expect(einProblem('98-7654321')).toBeNull();
  });

  it('names what is wrong', () => {
    expect(einProblem('12-345678')).toBe('format');
    expect(einProblem('1234')).toBe('format');
    expect(einProblem('07-1234567')).toBe('prefix');
    expect(einProblem('00-1234567')).toBe('prefix');
    expect(einProblem('49-1234567')).toBe('prefix');
  });

  it('normalises nine digits to XX-XXXXXXX', () => {
    expect(normalizeEin('123456789')).toBe('12-3456789');
    expect(normalizeEin(' 12-3456789 ')).toBe('12-3456789');
  });
});

describe('SSN', () => {
  it('formats while typing', () => {
    expect(formatSsnInput('123')).toBe('123');
    expect(formatSsnInput('1234')).toBe('123-4');
    expect(formatSsnInput('123456')).toBe('123-45-6');
    expect(formatSsnInput('123456789012')).toBe('123-45-6789');
  });

  it('accepts a number the SSA could issue', () => {
    expect(ssnProblem('')).toBeNull();
    expect(ssnProblem('123-45-6789')).toBeNull();
    expect(ssnProblem('123456789')).toBeNull();
  });

  it('rejects numbers that are never issued', () => {
    expect(ssnProblem('123-45-678')).toBe('format');
    expect(ssnProblem('000-12-3456')).toBe('area');
    expect(ssnProblem('666-12-3456')).toBe('area');
    expect(ssnProblem('900-12-3456')).toBe('area');
    expect(ssnProblem('078-05-1120')).toBe('area');
    expect(ssnProblem('123-00-4567')).toBe('group');
    expect(ssnProblem('123-45-0000')).toBe('serial');
  });

  it('normalises and masks', () => {
    expect(normalizeSsn('123456789')).toBe('123-45-6789');
    expect(maskedSsn('6789')).toBe('•••-••-6789');
    expect(maskedSsn(null)).toBe('•••-••-••••');
    expect(maskedSsn('12')).toBe('•••-••-••••');
  });
});

describe('time zones', () => {
  it('picks the primary zone of a state, New York when unknown', () => {
    expect(defaultUsTimeZone('TX')).toBe('America/Chicago');
    expect(defaultUsTimeZone('az')).toBe('America/Phoenix');
    expect(defaultUsTimeZone('HI')).toBe('Pacific/Honolulu');
    expect(defaultUsTimeZone(undefined)).toBe('America/New_York');
    expect(defaultUsTimeZone('ZZ')).toBe('America/New_York');
  });

  it('offers every US zone and keeps the entity current one', () => {
    expect(timeZoneOptions()).toEqual([...US_TIME_ZONES]);
    expect(timeZoneOptions('America/Chicago')).toEqual([...US_TIME_ZONES]);
    expect(timeZoneOptions('Europe/Amsterdam')).toEqual([...US_TIME_ZONES, 'Europe/Amsterdam']);
  });
});
