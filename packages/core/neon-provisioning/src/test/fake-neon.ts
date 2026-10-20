/**
 * A fake of the Neon REST API as `NeonClient` exposes it, plus a way to put it
 * into a `DatabaseProvisioningService`. Every secret it hands out starts with
 * `secret-`, so a test can assert that nothing leaked into a log line.
 */

import { vi } from 'vitest';
import { DatabaseProvisioningService } from '../provisioning';

export const FAKE_SECRET_PREFIX = 'secret-';

/** Direct host of a project's endpoint in the fake. */
export function fakeHost(neonProjectId: string): string {
  return `ep-${neonProjectId}.eu-central-1.aws.neon.tech`;
}

/** The fake's project / branch / endpoint ids for a project it creates. */
export const CREATED_PROJECT = {
  projectId: 'prj-created',
  branchId: 'br-created',
  endpointId: 'ep-created-1',
  roleName: 'neondb_owner',
} as const;

interface FakeEndpoint {
  id: string;
  host: string;
  type: 'read_write' | 'read_only';
}

const finished = [{ id: 'op-1', action: 'apply_config', status: 'finished' }];

export function createFakeNeon() {
  return {
    createProject: vi.fn(async (name: string, region?: string, _options?: unknown) => ({
      project: { id: CREATED_PROJECT.projectId, name, region_id: region ?? 'aws-eu-central-1' },
      branch: { id: CREATED_PROJECT.branchId, name: 'main' },
      endpoints: [{ id: CREATED_PROJECT.endpointId, host: fakeHost('created'), type: 'read_write' }],
      roles: [{ name: CREATED_PROJECT.roleName, protected: false }],
      databases: [{ name: 'neondb' }],
      connection_uris: [
        {
          connection_parameters: {
            database: 'neondb',
            host: fakeHost('created'),
            password: `${FAKE_SECRET_PREFIX}${CREATED_PROJECT.roleName}`,
            role: CREATED_PROJECT.roleName,
          },
        },
      ],
    })),
    deleteProject: vi.fn(async (_projectId: string) => {}),

    createRole: vi.fn(async (_projectId: string, _branchId: string, name: string): Promise<{
      role: { name: string; password?: string };
      operations: typeof finished;
    }> => ({
      role: { name, password: `${FAKE_SECRET_PREFIX}${name}` },
      operations: finished,
    })),
    deleteRole: vi.fn(async (_projectId: string, _branchId: string, _name: string) => {}),
    getRolePassword: vi.fn(async (_projectId: string, _branchId: string, roleName: string) => ({
      password: `${FAKE_SECRET_PREFIX}api-${roleName}`,
    })),
    resetRolePassword: vi.fn(async (_projectId: string, _branchId: string, roleName: string) => ({
      password: `${FAKE_SECRET_PREFIX}rotated-${roleName}`,
      operations: finished,
    })),

    createDatabase: vi.fn(async (_projectId: string, _branchId: string, name: string, _owner: string) => ({
      database: { name },
      operations: finished,
    })),
    getDatabase: vi.fn(async (_projectId: string, _branchId: string, name: string) => ({ database: { name } })),
    deleteDatabase: vi.fn(async (_projectId: string, _branchId: string, _name: string) => finished),

    getConnectionUri: vi.fn(async (
      projectId: string,
      _branchId: string,
      databaseName: string,
      roleName: string,
      _options?: { pooled?: boolean },
    ) => `postgresql://${roleName}:${FAKE_SECRET_PREFIX}${roleName}@${fakeHost(projectId).replace('.', '-pooler.')}/${databaseName}?sslmode=require`),

    getMainBranch: vi.fn(async (_projectId: string) => ({ id: 'br-main' })),
    getEndpoint: vi.fn(async (projectId: string, _branchId: string) => ({
      id: `epid-${projectId}`,
      host: fakeHost(projectId),
      type: 'read_write' as const,
    })),
    listEndpoints: vi.fn(async (projectId: string): Promise<{ endpoints: FakeEndpoint[] }> => ({
      endpoints: [{ id: `epid-${projectId}`, host: fakeHost(projectId), type: 'read_write' }],
    })),
    restartEndpoint: vi.fn(async (_projectId: string, _endpointId: string) => finished),
    waitForOperations: vi.fn(async (_projectId: string, _operations: unknown[]) => {}),
  };
}

export type FakeNeon = ReturnType<typeof createFakeNeon>;

/** A provisioning service whose Neon client is the given fake. */
export function createServiceWith(fake: FakeNeon): DatabaseProvisioningService {
  const service = new DatabaseProvisioningService({
    NEON_API_KEY: 'test-api-key',
    NEON_DEFAULT_REGION: 'aws-eu-central-1',
  });
  // `neonClient` is a private readonly field; the tests swap it for the fake.
  Object.assign(service, { neonClient: fake });
  return service;
}
