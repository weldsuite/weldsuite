import { afterEach, describe, expect, it } from 'vitest';
import { encryptWorkspaceDatabaseUrl } from '@weldsuite/db/lib/crypto';
import { openStoredUrl, type WorkspaceDatabaseRow } from './db';

const KEY = 'ab'.repeat(32);
const TENANT = 'postgres://tenant:secret@pooler.weldsuite.svc:5432/ws_1';

function row(databaseUrl: string | null, id = 'ws_1'): WorkspaceDatabaseRow {
  return { id, databaseUrl, neonProjectId: null, neonBranchId: null, neonRoleName: null, neonDatabaseName: null };
}

afterEach(() => {
  delete process.env.DATABASE_ENCRYPTION_KEY;
  delete process.env.DATABASE_ENCRYPTION_KEY_V2;
});

describe('openStoredUrl (Kubernetes: the URL the Rust server stored)', () => {
  it('opens a v3 value sealed for this workspace', async () => {
    process.env.DATABASE_ENCRYPTION_KEY_V2 = KEY;
    const sealed = await encryptWorkspaceDatabaseUrl(TENANT, 'ws_1', { v2: KEY, aadWrites: true });
    expect(sealed.startsWith('v3:')).toBe(true);
    await expect(openStoredUrl(row(sealed))).resolves.toBe(TENANT);
  });

  it('refuses a value sealed for another workspace', async () => {
    process.env.DATABASE_ENCRYPTION_KEY_V2 = KEY;
    const sealed = await encryptWorkspaceDatabaseUrl(TENANT, 'ws_other', { v2: KEY, aadWrites: true });
    await expect(openStoredUrl(row(sealed))).rejects.toThrow();
  });

  it('says which key is missing instead of trying anything else', async () => {
    const sealed = await encryptWorkspaceDatabaseUrl(TENANT, 'ws_1', { v2: KEY, aadWrites: true });
    await expect(openStoredUrl(row(sealed))).rejects.toThrow(/DATABASE_ENCRYPTION_KEY is not set/);
  });

  it('takes a plain URL as it is', async () => {
    await expect(openStoredUrl(row(TENANT))).resolves.toBe(TENANT);
  });

  it('refuses a workspace without a stored URL', async () => {
    await expect(openStoredUrl(row(null))).rejects.toThrow(/No database configured for workspace: ws_1/);
  });
});
