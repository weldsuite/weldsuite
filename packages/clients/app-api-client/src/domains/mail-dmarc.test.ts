import { describe, expect, it } from 'vitest';
import {
  dmarcPeriodDaysSchema,
  mailDnsRecordSchema,
  markDmarcSourceSchema,
} from '../schemas/mail-domains';
import { createMailDomainsApi } from './mail-domains';
import { RESPONSE, recordingApi } from './recording-api.test-helper';

describe('WeldMail DMARC client (ADR MAIL-015)', () => {
  it('asks for a domain summary over a period, 30 days by default', async () => {
    const { api, calls } = recordingApi();
    const mailDomains = createMailDomainsApi(api);
    expect(await mailDomains.dmarcSummary('mdom_1')).toBe(RESPONSE);
    await mailDomains.dmarcSummary('mdom_1', 90);
    expect(calls).toEqual([
      { method: 'GET', path: '/mail-domains/mdom_1/dmarc?days=30', body: undefined },
      { method: 'GET', path: '/mail-domains/mdom_1/dmarc?days=90', body: undefined },
    ]);
  });

  it('pages through the reports', async () => {
    const { api, calls } = recordingApi();
    await createMailDomainsApi(api).dmarcReports('mdom_1', { limit: 25, cursor: '25' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.path).toMatch(/^\/mail-domains\/mdom_1\/dmarc\/reports\?/);
    expect(calls[0]?.path).toContain('limit=25');
    expect(calls[0]?.path).toContain('cursor=25');
  });

  it('marks a source in the body, as its key holds colons and dots', async () => {
    const { api, calls } = recordingApi();
    const body = { key: 'name:mailer.example', mark: 'not_mine' as const };
    await createMailDomainsApi(api).markDmarcSource('mdom_1', body);
    expect(calls).toEqual([{ method: 'PATCH', path: '/mail-domains/mdom_1/dmarc/sources', body }]);
  });
});

describe('WeldMail DMARC schemas', () => {
  it('reads a DMARC record entry with its check, and one without', () => {
    const checked = mailDnsRecordSchema.parse({
      type: 'TXT',
      name: '_dmarc.acme.nl',
      value: 'v=DMARC1; p=reject; rua=mailto:dmarc@reports.weldsuite.eu',
      purpose: 'dmarc',
      verified: false,
      dmarc: {
        state: 'multiple',
        found: ['v=DMARC1; p=none', 'v=DMARC1; p=reject'],
        policy: null,
        reportsToWeldSuite: false,
      },
    });
    expect(checked.dmarc?.state).toBe('multiple');
    const plain = mailDnsRecordSchema.parse({
      type: 'MX',
      name: 'acme.nl',
      value: 'mx.weldsuite.eu',
      verified: true,
    });
    expect(plain.dmarc).toBeUndefined();
  });

  it('takes only the periods and marks the API knows', () => {
    expect(dmarcPeriodDaysSchema.safeParse(90).success).toBe(true);
    expect(dmarcPeriodDaysSchema.safeParse(14).success).toBe(false);
    expect(markDmarcSourceSchema.safeParse({ key: 'ip:1.2.3.4', mark: null }).success).toBe(true);
    expect(markDmarcSourceSchema.safeParse({ key: 'ip:1.2.3.4', mark: 'maybe' }).success).toBe(
      false,
    );
  });
});
