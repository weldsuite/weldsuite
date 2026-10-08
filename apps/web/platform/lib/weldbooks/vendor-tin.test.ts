import { describe, expect, it } from 'vitest';
import {
  formatTinInput,
  isVendorTinType,
  itinProblem,
  maskedTin,
  normalizeTin,
  tinPlaceholder,
  tinProblem,
} from './vendor-tin';

describe('tinProblem', () => {
  it('accepts a well-formed EIN, SSN and ITIN, with or without dashes', () => {
    expect(tinProblem('ein', '12-3456789')).toBeNull();
    expect(tinProblem('ein', '123456789')).toBeNull();
    expect(tinProblem('ssn', '123-45-6789')).toBeNull();
    expect(tinProblem('itin', '912-70-1234')).toBeNull();
    expect(tinProblem('itin', '912701234')).toBeNull();
  });

  it('treats an empty value as no problem: nothing was typed', () => {
    expect(tinProblem('ein', '')).toBeNull();
    expect(tinProblem('ssn', '   ')).toBeNull();
  });

  it('rejects a wrong length or characters', () => {
    expect(tinProblem('ein', '12-345678')).toBe('format');
    expect(tinProblem('ssn', '123-45-678')).toBe('format');
    expect(tinProblem('itin', '9127012')).toBe('format');
    expect(tinProblem('ssn', 'abc-de-fghi')).toBe('format');
  });

  it('rejects an EIN prefix the IRS does not assign', () => {
    expect(tinProblem('ein', '00-1234567')).toBe('prefix');
    expect(tinProblem('ein', '07-1234567')).toBe('prefix');
  });

  it('rejects SSNs the SSA does not issue', () => {
    expect(tinProblem('ssn', '000-12-3456')).toBe('area');
    expect(tinProblem('ssn', '666-12-3456')).toBe('area');
    expect(tinProblem('ssn', '900-12-3456')).toBe('area');
    expect(tinProblem('ssn', '123-00-3456')).toBe('group');
    expect(tinProblem('ssn', '123-45-0000')).toBe('serial');
    expect(tinProblem('ssn', '078-05-1120')).toBe('area');
  });

  it('rejects an ITIN that does not start with 9 or has a middle group the IRS does not issue', () => {
    expect(tinProblem('itin', '123-45-6789')).toBe('area');
    expect(tinProblem('itin', '912-93-1234')).toBe('group');
    expect(tinProblem('itin', '912-69-1234')).toBe('group');
    expect(itinProblem('999-99-9999')).toBeNull();
    expect(itinProblem('900-50-0000')).toBeNull();
  });
});

describe('formatting', () => {
  it('formats what has been typed so far with the dashes of the type', () => {
    expect(formatTinInput('ein', '123456789')).toBe('12-3456789');
    expect(formatTinInput('ein', '12')).toBe('12');
    expect(formatTinInput('ssn', '123456789')).toBe('123-45-6789');
    expect(formatTinInput('itin', '91270')).toBe('912-70');
    expect(formatTinInput('ssn', '123-45-6789012')).toBe('123-45-6789');
  });

  it('normalizes a complete TIN to the form the server stores', () => {
    expect(normalizeTin('ein', '123456789')).toBe('12-3456789');
    expect(normalizeTin('ssn', '123456789')).toBe('123-45-6789');
    expect(normalizeTin('itin', '912701234')).toBe('912-70-1234');
  });

  it('masks to the last four digits in the IRS truncation format', () => {
    expect(maskedTin('ein', '1234')).toBe('**-***1234');
    expect(maskedTin('ssn', '6789')).toBe('***-**-6789');
    expect(maskedTin('itin', '1234')).toBe('***-**-1234');
    expect(maskedTin(null, '1234')).toBe('***-**-1234');
    expect(maskedTin('ein', null)).toBe('**-***' + '****');
  });

  it('knows its types and placeholders', () => {
    expect(isVendorTinType('ein')).toBe(true);
    expect(isVendorTinType('passport')).toBe(false);
    expect(tinPlaceholder('ein')).toBe('12-3456789');
    expect(tinPlaceholder('ssn')).toBe('123-45-6789');
    expect(tinPlaceholder('itin')).toBe('9XX-XX-XXXX');
  });
});
