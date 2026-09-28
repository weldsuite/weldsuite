import { describe, it, expect } from 'vitest';
import { deriveDisplayName, CompanyVersionConflictError } from './companies';

describe('deriveDisplayName', () => {
  it('prefers tradingName when present', () => {
    expect(deriveDisplayName({ name: 'Acme Inc.', tradingName: 'Acme' })).toBe('Acme');
  });

  it('trims whitespace before deciding', () => {
    expect(deriveDisplayName({ name: 'Acme Inc.', tradingName: '   ' })).toBe('Acme Inc.');
  });

  it('falls back to name when tradingName is missing', () => {
    expect(deriveDisplayName({ name: 'Acme Inc.', tradingName: null })).toBe('Acme Inc.');
  });

  it('uses "Unnamed Company" when both are empty', () => {
    expect(deriveDisplayName({ name: null, tradingName: null })).toBe('Unnamed Company');
    expect(deriveDisplayName({ name: '', tradingName: '' })).toBe('Unnamed Company');
  });
});

describe('CompanyVersionConflictError', () => {
  it('carries the isConflict flag so routes can map it to 409', () => {
    const err = new CompanyVersionConflictError();
    expect(err.isConflict).toBe(true);
    expect(err.name).toBe('CompanyVersionConflictError');
  });
});
