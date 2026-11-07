import { describe, expect, it } from 'vitest';
import type { MergeRecordLinkDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import { collectIssueCustomers, formatMinutes, toMinutes } from './across';

const link = (over: Partial<MergeRecordLinkDto>): MergeRecordLinkDto => ({
  id: 'mrl_1',
  issueId: 'mis_1',
  recordType: 'desk_ticket',
  recordId: 'tkt_1',
  title: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

describe('formatMinutes', () => {
  it('reads as hours and minutes', () => {
    expect(formatMinutes(0)).toBe('0m');
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(60)).toBe('1h');
    expect(formatMinutes(90)).toBe('1h 30m');
    expect(formatMinutes(-5)).toBe('0m');
  });
});

describe('toMinutes', () => {
  it('converts hours and minutes, and rejects what is not a positive number', () => {
    expect(toMinutes('90', 'minutes')).toBe(90);
    expect(toMinutes('1,5', 'hours')).toBe(90);
    expect(toMinutes('0', 'minutes')).toBe(0);
    expect(toMinutes('abc', 'hours')).toBe(0);
    expect(toMinutes('-2', 'hours')).toBe(0);
  });
});

describe('collectIssueCustomers', () => {
  it('lists direct companies and those reached through tickets once each', () => {
    const links = [
      link({ id: 'a', recordType: 'crm_company', recordId: 'cus_1', title: 'Acme' }),
      link({ id: 'b', recordType: 'desk_ticket', recordId: 'tkt_1', title: 'Login broken' }),
      link({ id: 'c', recordType: 'desk_ticket', recordId: 'tkt_2', title: 'Slow' }),
      link({ id: 'd', recordType: 'chat_channel', recordId: 'ch_1' }),
    ];
    const ticketCompanies = new Map<string, string | null>([
      ['tkt_1', 'cus_1'],
      ['tkt_2', 'cus_2'],
    ]);
    expect(collectIssueCustomers(links, ticketCompanies)).toEqual([
      { companyId: 'cus_1', title: 'Acme', viaTicket: null },
      { companyId: 'cus_2', title: null, viaTicket: { id: 'tkt_2', title: 'Slow' } },
    ]);
  });

  it('skips tickets without a company', () => {
    expect(collectIssueCustomers([link({})], new Map([['tkt_1', null]]))).toEqual([]);
  });
});
