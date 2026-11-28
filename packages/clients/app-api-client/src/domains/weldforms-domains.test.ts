import { describe, expect, it } from 'vitest';
import { addFormDomainSchema, formDomainSchema, updateFormDomainSchema } from '../schemas/weldforms';
import { createWeldFormsApi } from './weldforms';
import { RESPONSE, recordingApi } from './recording-api.test-helper';

describe('WeldForms custom domains client', () => {
  it('calls each domain route', async () => {
    const { api, calls } = recordingApi();
    const forms = createWeldFormsApi(api);
    expect(await forms.domainsConfig()).toBe(RESPONSE);
    await forms.domains();
    await forms.addDomain({ hostname: 'forms.acme.com' });
    await forms.refreshDomain('fdom_1');
    await forms.makeDomainPrimary('fdom_1');
    await forms.updateDomain('fdom_1', { homeFormPublicId: null });
    await forms.removeDomain('fdom_1');
    expect(calls).toEqual([
      { method: 'GET', path: '/forms/domains/config', body: undefined },
      { method: 'GET', path: '/forms/domains', body: undefined },
      { method: 'POST', path: '/forms/domains', body: { hostname: 'forms.acme.com' } },
      { method: 'POST', path: '/forms/domains/fdom_1/refresh', body: undefined },
      { method: 'POST', path: '/forms/domains/fdom_1/primary', body: undefined },
      { method: 'PATCH', path: '/forms/domains/fdom_1', body: { homeFormPublicId: null } },
      { method: 'DELETE', path: '/forms/domains/fdom_1', body: undefined },
    ]);
  });
});

describe('WeldForms custom domain schemas', () => {
  it('reads a domain as the server answers it', () => {
    const domain = formDomainSchema.parse({
      id: 'fdom_1',
      hostname: 'forms.acme.com',
      isPrimary: false,
      status: 'pending',
      sslStatus: null,
      lastError: 'Add the TXT record _weldforms.forms.acme.com',
      lastCheckedAt: null,
      verifiedAt: null,
      homeFormPublicId: null,
      url: 'https://forms.acme.com',
      dnsRecords: [
        { type: 'TXT', name: '_weldforms.forms.acme.com', value: 'weldforms-verify=abc', purpose: 'ownership', satisfied: false },
        { type: 'CNAME', name: 'forms.acme.com', value: 'forms.weldsuite.eu', purpose: 'routing', satisfied: false },
      ],
      createdAt: '2026-11-27T10:00:00.000Z',
    });
    expect(domain.dnsRecords).toHaveLength(2);
    expect(() => formDomainSchema.parse({ ...domain, status: 'live' })).toThrow();
  });

  it('trims a host name and allows clearing the home form', () => {
    expect(addFormDomainSchema.parse({ hostname: '  forms.acme.com ' }).hostname).toBe('forms.acme.com');
    expect(addFormDomainSchema.safeParse({ hostname: '   ' }).success).toBe(false);
    expect(updateFormDomainSchema.parse({ homeFormPublicId: null })).toEqual({ homeFormPublicId: null });
  });
});
