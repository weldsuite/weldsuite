import { describe, expect, it } from 'vitest';
import { catalogFlag, catalogFlags, formatFlagValue, parseFlagValue } from './flags';

describe('catalogFlags', () => {
  it('lists the catalog in key order with each type and default', () => {
    const flags = catalogFlags();
    expect(flags.map((f) => f.key)).toEqual([...flags.map((f) => f.key)].sort((a, b) => a.localeCompare(b)));
    expect(catalogFlag('weldreach-sending')).toEqual({ key: 'weldreach-sending', type: 'boolean', default: true });
  });

  it('knows no flag outside the catalog', () => {
    expect(catalogFlag('no-such-flag')).toBeNull();
    expect(catalogFlag('toString')).toBeNull();
  });
});

describe('parseFlagValue', () => {
  it('takes true or false for a boolean, nothing else', () => {
    expect(parseFlagValue('boolean', 'true')).toEqual({ ok: true, value: true });
    expect(parseFlagValue('boolean', ' false ')).toEqual({ ok: true, value: false });
    expect(parseFlagValue('boolean', 'yes')).toEqual({ ok: false, error: 'notBoolean' });
  });

  it('takes a finite number', () => {
    expect(parseFlagValue('number', '12.5')).toEqual({ ok: true, value: 12.5 });
    for (const text of ['', 'abc', 'Infinity']) expect(parseFlagValue('number', text)).toEqual({ ok: false, error: 'notNumber' });
  });

  it('keeps text as typed, up to 500 characters', () => {
    expect(parseFlagValue('string', 'enforce')).toEqual({ ok: true, value: 'enforce' });
    expect(parseFlagValue('string', 'x'.repeat(501))).toEqual({ ok: false, error: 'tooLong' });
  });

  it('takes JSON for a json flag', () => {
    expect(parseFlagValue('json', '{"a":[1,2]}')).toEqual({ ok: true, value: { a: [1, 2] } });
    expect(parseFlagValue('json', '{a:1}')).toEqual({ ok: false, error: 'notJson' });
  });
});

describe('formatFlagValue', () => {
  it('shows text as is and anything else as JSON', () => {
    expect(formatFlagValue('shadow')).toBe('shadow');
    expect(formatFlagValue(true)).toBe('true');
    expect(formatFlagValue({ a: 1 })).toBe('{"a":1}');
  });
});
