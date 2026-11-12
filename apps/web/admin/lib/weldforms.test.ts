import { describe, expect, it } from 'vitest';
import {
  canResolveReport,
  cleanReason,
  formState,
  publicFormUrl,
  readReportFilter,
  reasonLabel,
  weldformsHref,
} from './weldforms';

describe('weldforms moderation helpers', () => {
  it('reads the status filter, defaulting to open', () => {
    expect(readReportFilter(undefined)).toBe('open');
    expect(readReportFilter('bogus')).toBe('open');
    expect(readReportFilter('all')).toBe('all');
    expect(readReportFilter('dismissed')).toBe('dismissed');
  });

  it('builds the public link', () => {
    expect(publicFormUrl('https://forms.weldsuite.org/', 'abc123')).toBe('https://forms.weldsuite.org/f/abc123');
    expect(publicFormUrl('https://forms-test.weldsuite.org', 'a b')).toBe('https://forms-test.weldsuite.org/f/a%20b');
  });

  it('lets suspension win over a hold', () => {
    expect(formState({ suspendedAt: new Date(), heldAt: new Date() })).toBe('suspended');
    expect(formState({ suspendedAt: null, heldAt: new Date() })).toBe('held');
    expect(formState({ suspendedAt: null, heldAt: null })).toBe('live');
  });

  it('cleans reasons', () => {
    expect(cleanReason('  phishing  ')).toBe('phishing');
    expect(cleanReason('ab')).toBeNull();
    expect(cleanReason(5)).toBeNull();
    expect(cleanReason('x'.repeat(501))).toBeNull();
  });

  it('resolves only open reports', () => {
    expect(canResolveReport('open')).toBe(true);
    expect(canResolveReport('dismissed')).toBe(false);
  });

  it('labels reasons and builds filter links', () => {
    expect(reasonLabel('phishing')).toBe('Phishing');
    expect(reasonLabel('weird')).toBe('weird');
    expect(weldformsHref('open')).toBe('/weldforms');
    expect(weldformsHref('all')).toBe('/weldforms?status=all');
  });
});
