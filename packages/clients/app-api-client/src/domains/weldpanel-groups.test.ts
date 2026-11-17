import { describe, expect, it } from 'vitest';
import type { ClientApi } from '../types';
import { createWeldPanelGroupsApi, type WeldPanelGroupsApi } from './weldpanel-groups';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RecordedCall {
  method: Method;
  path: string;
  body?: unknown;
}

const RESPONSE = { data: 'from the fake api' };

function recordingApi(): { api: ClientApi; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const record =
    (method: Method) =>
    <T>(path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      return Promise.resolve(RESPONSE as T);
    };
  const api: ClientApi = {
    get: record('GET'),
    getRaw: () => Promise.reject(new Error('getRaw is not used by the WeldPanel groups client')),
    post: record('POST'),
    put: record('PUT'),
    patch: record('PATCH'),
    delete: record('DELETE'),
    postForm: () => Promise.reject(new Error('postForm is not used by the WeldPanel groups client')),
  };
  return { api, calls };
}

const CASES: { name: string; call: (client: WeldPanelGroupsApi) => Promise<unknown>; expected: RecordedCall }[] = [
  {
    name: 'listGroupTypes',
    call: (c) => c.listGroupTypes('pnp_1'),
    expected: { method: 'GET', path: '/panel/group-types?projectId=pnp_1' },
  },
  {
    name: 'createGroupType',
    call: (c) => c.createGroupType({ projectId: 'pnp_1', groupType: 'company', nameSingular: 'Company', namePlural: 'Companies' }),
    expected: {
      method: 'POST',
      path: '/panel/group-types',
      body: { projectId: 'pnp_1', groupType: 'company', nameSingular: 'Company', namePlural: 'Companies' },
    },
  },
  {
    name: 'updateGroupType',
    call: (c) => c.updateGroupType('pngt_1', { crmMatchProperty: 'domain' }),
    expected: { method: 'PATCH', path: '/panel/group-types/pngt_1', body: { crmMatchProperty: 'domain' } },
  },
  {
    name: 'deleteGroupType',
    call: (c) => c.deleteGroupType('pngt_1'),
    expected: { method: 'DELETE', path: '/panel/group-types/pngt_1' },
  },
  {
    name: 'listGroups',
    call: (c) => c.listGroups({ projectId: 'pnp_1', type: 'company', search: 'acme co', limit: 20 }),
    expected: { method: 'GET', path: '/panel/groups?projectId=pnp_1&type=company&search=acme+co&limit=20' },
  },
  {
    name: 'listGroups leaves out empty params',
    call: (c) => c.listGroups({ projectId: 'pnp_1', type: 'company', search: '', cursor: null }),
    expected: { method: 'GET', path: '/panel/groups?projectId=pnp_1&type=company' },
  },
  {
    name: 'getGroup with a window',
    call: (c) => c.getGroup('pnp_1', 'company', 'acme inc/eu', { days: 30 }),
    expected: { method: 'GET', path: '/panel/groups/company/acme%20inc%2Feu?projectId=pnp_1&days=30' },
  },
  {
    name: 'getGroup without a window',
    call: (c) => c.getGroup('pnp_1', 'company', 'acme'),
    expected: { method: 'GET', path: '/panel/groups/company/acme?projectId=pnp_1' },
  },
  {
    name: 'deleteGroup',
    call: (c) => c.deleteGroup('pnp_1', 'company', 'a&b'),
    expected: { method: 'DELETE', path: '/panel/groups/company/a%26b?projectId=pnp_1' },
  },
];

describe('WeldPanel groups client', () => {
  it.each(CASES)('$name sends $expected.method $expected.path', async ({ call, expected }) => {
    const { api, calls } = recordingApi();
    await expect(call(createWeldPanelGroupsApi(api))).resolves.toBe(RESPONSE);
    expect(calls).toEqual([expected]);
  });
});
