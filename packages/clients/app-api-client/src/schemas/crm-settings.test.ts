import { describe, expect, it } from 'vitest';
import { createCrmSettingsApi } from '../domains/crm-settings';
import type { ClientApi } from '../types';
import { crmSettingsSchema, updateCrmSettingsSchema } from './crm-settings';

describe('crm settings schemas', () => {
  it('reads the settings the route answers', () => {
    const settings = {
      autoAdd: {
        enabled: true,
        createCompanies: false,
        sources: { email: true, meetings: false, helpdesk: true },
      },
    };
    expect(crmSettingsSchema.parse(settings)).toEqual(settings);
    expect(() => crmSettingsSchema.parse({ autoAdd: { enabled: true } })).toThrow();
  });

  it('takes a partial update', () => {
    expect(updateCrmSettingsSchema.parse({})).toEqual({});
    expect(updateCrmSettingsSchema.parse({ autoAdd: { sources: { helpdesk: false } } })).toEqual({
      autoAdd: { sources: { helpdesk: false } },
    });
    expect(() => updateCrmSettingsSchema.parse({ autoAdd: { enabled: 'yes' } })).toThrow();
  });

  it('calls the crm-settings paths', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const record = (method: string) => async (path: string, data?: unknown) => {
      calls.push([method, path, data]);
      return {};
    };
    const api = {
      get: record('GET'),
      post: record('POST'),
      put: record('PUT'),
      delete: record('DELETE'),
    } as unknown as ClientApi;
    const client = createCrmSettingsApi(api);

    await client.get();
    await client.update({ autoAdd: { enabled: true } });

    expect(calls).toEqual([
      ['GET', '/crm-settings', undefined],
      ['PUT', '/crm-settings', { autoAdd: { enabled: true } }],
    ]);
  });
});
