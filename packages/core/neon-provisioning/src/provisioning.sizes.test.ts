/**
 * `listShardDatabaseSizes`: one catalog query on the shard through its admin
 * role. The driver and the Neon API are fakes; what matters is the query, the
 * mapping, the `null` when there is no admin access, and that the admin URI
 * (which carries a password) never ends up in an error or a log line.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import type { NeonSharedProject } from '@weldsuite/db/schema/master';

const driver = vi.hoisted(() => ({
  neon: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@neondatabase/serverless', () => ({ neon: driver.neon }));

import { FAKE_SECRET_PREFIX, createFakeNeon, createServiceWith } from './test/fake-neon';

function shard(over: Partial<NeonSharedProject> = {}): NeonSharedProject {
  return {
    id: 'nsp_a',
    neonProjectId: 'prj-a',
    neonProjectName: 'shard a',
    region: 'aws-eu-central-1',
    mainBranchId: 'br-main',
    connectionHost: null,
    connectionPort: 5432,
    adminRole: 'shard_admin',
    adminPasswordEncrypted: null,
    databaseCount: 3,
    maxDatabases: 500,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  driver.query.mockReset();
  driver.neon.mockReset();
  driver.neon.mockReturnValue({ query: driver.query });
  consoleSpies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  const output = consoleSpies.map((spy) => inspect(spy.mock.calls, { depth: 6 })).join('\n');
  vi.restoreAllMocks();
  expect(output).not.toContain(FAKE_SECRET_PREFIX);
  expect(output).not.toContain('postgresql://');
});

describe('listShardDatabaseSizes', () => {
  it('reads pg_database_size over the shard admin role and maps the rows', async () => {
    driver.query.mockResolvedValue([
      { datname: 'ws_big', size_bytes: '5368709120' },
      { datname: 'ws_small', size_bytes: 8_000_000 },
    ]);
    const fake = createFakeNeon();
    const service = createServiceWith(fake);

    const sizes = await service.listShardDatabaseSizes(shard());

    expect(sizes).toEqual([
      { databaseName: 'ws_big', sizeBytes: 5_368_709_120 },
      { databaseName: 'ws_small', sizeBytes: 8_000_000 },
    ]);
    expect(fake.getConnectionUri).toHaveBeenCalledWith('prj-a', 'br-main', 'neondb', 'shard_admin', { pooled: false });
    expect(driver.query).toHaveBeenCalledTimes(1);
    const sql = String(driver.query.mock.calls[0]?.[0]);
    expect(sql).toContain('pg_database_size');
    expect(sql).toContain("NOT IN ('postgres', 'template0', 'template1')");
  });

  it('also accepts a driver that returns { rows }', async () => {
    driver.query.mockResolvedValue({ rows: [{ datname: 'ws_a', size_bytes: '10' }] });
    const service = createServiceWith(createFakeNeon());
    expect(await service.listShardDatabaseSizes(shard())).toEqual([{ databaseName: 'ws_a', sizeBytes: 10 }]);
  });

  it('returns null, without connecting, for a shard with no admin role or main branch', async () => {
    const service = createServiceWith(createFakeNeon());
    expect(await service.listShardDatabaseSizes(shard({ adminRole: null }))).toBeNull();
    expect(await service.listShardDatabaseSizes(shard({ mainBranchId: null }))).toBeNull();
    expect(driver.neon).not.toHaveBeenCalled();
  });

  it('returns null when the admin URI cannot be resolved', async () => {
    const fake = createFakeNeon();
    fake.getConnectionUri.mockRejectedValueOnce(new Error('Neon is down'));
    const service = createServiceWith(fake);
    expect(await service.listShardDatabaseSizes(shard())).toBeNull();
    expect(driver.neon).not.toHaveBeenCalled();
  });

  it('lets a failed query surface, without the URI in the error', async () => {
    driver.query.mockRejectedValue(new Error('connection terminated'));
    const service = createServiceWith(createFakeNeon());
    const error = await service.listShardDatabaseSizes(shard()).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain('postgresql://');
    expect(String((error as Error).message)).not.toContain(FAKE_SECRET_PREFIX);
  });
});
