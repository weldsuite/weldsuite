import { describe, it, expect } from 'vitest';
import {
  EIN_VALID_PREFIX_RANGES,
  isValidAbaChecksum,
  isValidAbaPrefix,
  isValidEinPrefix,
  isTinType,
  maskTin,
  normalizeZip,
  tinLast4,
  validateEin,
  validateItin,
  validateRoutingNumber,
  validateSsn,
  validateStateTaxId,
  validateTin,
  validateZip,
  zip5,
} from './identifiers';

describe('EIN', () => {
  it('formats nine digits as XX-XXXXXXX', () => {
    expect(validateEin('123456789')).toEqual({ valid: true, formatted: '12-3456789' });
    expect(validateEin(' 12-3456789 ')).toEqual({ valid: true, formatted: '12-3456789' });
  });

  it('accepts every assigned prefix and rejects every unassigned one', () => {
    const invalid = [0, 7, 8, 9, 17, 18, 19, 28, 29, 49, 69, 70, 78, 79, 89, 96, 97];
    for (let prefix = 0; prefix <= 99; prefix++) {
      const text = String(prefix).padStart(2, '0');
      const result = validateEin(`${text}-1234567`);
      expect(result.valid, `prefix ${text}`).toBe(!invalid.includes(prefix));
    }
  });

  it('keeps the prefix list as data', () => {
    expect(EIN_VALID_PREFIX_RANGES).toContainEqual([1, 6]);
    expect(isValidEinPrefix('27')).toBe(true);
    expect(isValidEinPrefix(49)).toBe(false);
    expect(isValidEinPrefix('abc')).toBe(false);
    expect(isValidEinPrefix(100)).toBe(false);
  });

  it('rejects malformed values', () => {
    for (const bad of ['', '12-345678', '12-34567890', '1-23456789', '12 3456789', 'AB-1234567', '123-45-6789']) {
      expect(validateEin(bad).valid, bad).toBe(false);
    }
    expect(validateEin('07-1234567').error).toMatch(/prefix 07/);
  });
});

describe('SSN', () => {
  it('formats nine digits as XXX-XX-XXXX', () => {
    expect(validateSsn('123456789')).toEqual({ valid: true, formatted: '123-45-6789' });
    expect(validateSsn('123-45-6789')).toEqual({ valid: true, formatted: '123-45-6789' });
  });

  it('rejects area 000, 666 and 900-999', () => {
    expect(validateSsn('000-12-3456').valid).toBe(false);
    expect(validateSsn('666-12-3456').valid).toBe(false);
    expect(validateSsn('900-12-3456').valid).toBe(false);
    expect(validateSsn('987-65-4321').valid).toBe(false);
    expect(validateSsn('999-12-3456').valid).toBe(false);
    expect(validateSsn('899-12-3456').valid).toBe(true);
    expect(validateSsn('665-12-3456').valid).toBe(true);
    expect(validateSsn('667-12-3456').valid).toBe(true);
  });

  it('rejects group 00 and serial 0000', () => {
    expect(validateSsn('123-00-6789').error).toMatch(/group/);
    expect(validateSsn('123-45-0000').error).toMatch(/serial/);
  });

  it('rejects the SSNs the SSA voided after they were used in advertising', () => {
    expect(validateSsn('078-05-1120').valid).toBe(false);
    expect(validateSsn('219-09-9999').valid).toBe(false);
  });

  it('rejects malformed values', () => {
    for (const bad of ['', '123-456789', '12345-6789', '12-34-56789', '123-45-678', 'abc-de-fghi']) {
      expect(validateSsn(bad).valid, bad).toBe(false);
    }
  });
});

describe('ITIN', () => {
  it('accepts a 9 prefix with an issued middle group', () => {
    expect(validateItin('912-70-1234')).toEqual({ valid: true, formatted: '912-70-1234' });
    expect(validateItin('900501234')).toEqual({ valid: true, formatted: '900-50-1234' });
  });

  it('checks the fourth and fifth digits against the IRS ranges', () => {
    const issued = (n: number) => (n >= 50 && n <= 65) || (n >= 70 && n <= 88) || (n >= 90 && n <= 92) || (n >= 94 && n <= 99);
    for (let middle = 0; middle <= 99; middle++) {
      const text = String(middle).padStart(2, '0');
      expect(validateItin(`912-${text}-1234`).valid, `middle ${text}`).toBe(issued(middle));
    }
    // 93 is an adoption taxpayer identification number, not an ITIN.
    expect(validateItin('912-93-1234').valid).toBe(false);
  });

  it('rejects a number that does not start with 9', () => {
    expect(validateItin('812-70-1234').error).toMatch(/starts with 9/);
  });
});

describe('validateTin / maskTin / tinLast4', () => {
  it('dispatches by type', () => {
    expect(validateTin('ein', '12-3456789').valid).toBe(true);
    expect(validateTin('ssn', '123-45-6789').valid).toBe(true);
    expect(validateTin('itin', '912-70-1234').valid).toBe(true);
    expect(validateTin('ssn', '12-3456789').valid).toBe(false);
    expect(validateTin('ein', '123-45-6789').valid).toBe(false);
    expect(validateTin('itin', '123-45-6789').valid).toBe(false);
  });

  it('recognises TIN types', () => {
    expect(isTinType('ein')).toBe(true);
    expect(isTinType('passport')).toBe(false);
    expect(isTinType(undefined)).toBe(false);
  });

  it('masks to the last four digits in the IRS truncation format', () => {
    expect(maskTin('123-45-6789')).toBe('***-**-6789');
    expect(maskTin('12-3456789')).toBe('**-***6789');
    expect(maskTin('123456789', 'ein')).toBe('**-***6789');
    expect(maskTin('123456789', 'ssn')).toBe('***-**-6789');
    expect(maskTin('912-70-1234', 'itin')).toBe('***-**-1234');
  });

  it('never exposes more than four digits and survives bad input', () => {
    expect(maskTin('')).toBe('***-**-****');
    expect(maskTin('12')).toBe('***-**-****');
    expect(maskTin('not a tin')).toBe('***-**-****');
    expect(maskTin('123-45-6789')).not.toContain('123');
    expect(maskTin('12-3456789')).not.toContain('3456');
  });

  it('returns the last four digits of a nine-digit TIN only', () => {
    expect(tinLast4('123-45-6789')).toBe('6789');
    expect(tinLast4('12-3456789')).toBe('6789');
    expect(tinLast4('123456789')).toBe('6789');
    expect(tinLast4('12345')).toBeNull();
    expect(tinLast4('1234567890')).toBeNull();
    expect(tinLast4('abc')).toBeNull();
  });
});

describe('state tax ID', () => {
  it('accepts free text within sane limits', () => {
    expect(validateStateTaxId(' 12-345678-9 ')).toEqual({ valid: true, formatted: '12-345678-9' });
    expect(validateStateTaxId('SR-1234567').valid).toBe(true);
    expect(validateStateTaxId('TX 3-21234567-8').valid).toBe(true);
  });

  it('rejects empty, oversized and odd values', () => {
    expect(validateStateTaxId('').valid).toBe(false);
    expect(validateStateTaxId('   ').valid).toBe(false);
    expect(validateStateTaxId('x'.repeat(41)).valid).toBe(false);
    expect(validateStateTaxId('<script>').valid).toBe(false);
  });
});

describe('ABA routing number', () => {
  it('accepts real-world routing numbers', () => {
    for (const number of [
      '021000021', // JPMorgan Chase, New York
      '011000015', // Federal Reserve Bank of Boston
      '121000358', // Bank of America, California
      '026009593', // Bank of America, New York
      '322271627', // JPMorgan Chase, California
      '111000025', // Bank of America, Texas
      '091000019', // Wells Fargo, Minnesota
      '071000013', // JPMorgan Chase, Illinois
    ]) {
      expect(validateRoutingNumber(number), number).toEqual({ valid: true, formatted: number });
    }
  });

  it('checks the 3-7-1 weighted sum', () => {
    expect(isValidAbaChecksum('021000021')).toBe(true);
    expect(isValidAbaChecksum('021000022')).toBe(false);
    expect(isValidAbaChecksum('123456789')).toBe(false);
    expect(validateRoutingNumber('021000022').error).toMatch(/checksum/);
  });

  it('rejects a wrong length, non-digits and all zeros', () => {
    expect(validateRoutingNumber('02100002').valid).toBe(false);
    expect(validateRoutingNumber('0210000211').valid).toBe(false);
    expect(validateRoutingNumber('02100002A').valid).toBe(false);
    expect(validateRoutingNumber('').valid).toBe(false);
    expect(validateRoutingNumber('000000000').valid).toBe(false);
  });

  it('rejects a prefix that is not a Federal Reserve district even when the checksum passes', () => {
    expect(isValidAbaChecksum('400000008')).toBe(true);
    expect(validateRoutingNumber('400000008').valid).toBe(false);
    expect(validateRoutingNumber('400000008').error).toMatch(/prefix 40/);
  });

  it('knows the valid prefix ranges', () => {
    const valid = (n: number) => (n >= 0 && n <= 12) || (n >= 21 && n <= 32) || (n >= 61 && n <= 72) || n === 80;
    for (let prefix = 0; prefix <= 99; prefix++) {
      expect(isValidAbaPrefix(prefix), String(prefix)).toBe(valid(prefix));
    }
    expect(isValidAbaPrefix('abc')).toBe(false);
  });

  it('tolerates spaces typed between digits', () => {
    expect(validateRoutingNumber('021 000 021')).toEqual({ valid: true, formatted: '021000021' });
  });
});

describe('ZIP', () => {
  it('accepts ZIP and ZIP+4 and keeps leading zeros', () => {
    expect(validateZip('02134')).toEqual({ valid: true, formatted: '02134', zip5: '02134' });
    expect(validateZip('90210-1234')).toEqual({
      valid: true,
      formatted: '90210-1234',
      zip5: '90210',
      plus4: '1234',
    });
    expect(validateZip('902101234').formatted).toBe('90210-1234');
    expect(validateZip(' 10001 ').formatted).toBe('10001');
  });

  it('rejects malformed codes', () => {
    for (const bad of ['', '1234', '123456', '12345-678', '12345-67890', 'ABCDE', '12345 6789', '00000']) {
      expect(validateZip(bad).valid, bad).toBe(false);
    }
  });

  it('normalizes and extracts the five-digit part', () => {
    expect(normalizeZip('902101234')).toBe('90210-1234');
    expect(normalizeZip('02134')).toBe('02134');
    expect(normalizeZip('nope')).toBeNull();
    expect(normalizeZip(null)).toBeNull();
    expect(normalizeZip(undefined)).toBeNull();
    expect(zip5('90210-1234')).toBe('90210');
    expect(zip5('bad')).toBeNull();
    expect(zip5(null)).toBeNull();
  });
});
