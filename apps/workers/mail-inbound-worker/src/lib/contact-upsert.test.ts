/**
 * The inbound worker's contact upsert hands off to the shared mail-domain
 * helper: avatars keyed by the Clerk org id, no avatars without one, and a
 * tenant-DB failure never escapes. The helper itself is covered in
 * `@weldsuite/mail-domain` (contacts.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertMailContacts = vi.hoisted(() => vi.fn(async () => {}));
const getTenantDbForWorkspaceById = vi.hoisted(() => vi.fn(async () => ({ tenant: true })));
vi.mock('@weldsuite/mail-domain/contacts', () => ({ upsertMailContacts }));
vi.mock('../db', () => ({ getTenantDbForWorkspaceById }));

import { upsertContactsFromMailMessage } from './contact-upsert';
import type { Env } from '../index';

const env = { STORAGE: {}, R2_PUBLIC_URL: 'https://files.test.dev' } as unknown as Env;
const message = { from: { email: 'ada@example.com', name: 'Ada' }, to: [{ email: 'team@example.com' }] };

describe('upsertContactsFromMailMessage', () => {
  beforeEach(() => {
    upsertMailContacts.mockClear();
    getTenantDbForWorkspaceById.mockClear();
  });

  it('upserts into the workspace tenant DB with avatars under the Clerk org', async () => {
    await upsertContactsFromMailMessage(env, 'ws_1', 'org_1', message);

    expect(getTenantDbForWorkspaceById).toHaveBeenCalledWith(env, 'ws_1');
    expect(upsertMailContacts).toHaveBeenCalledWith(env, { tenant: true }, 'org_1', message);
  });

  it('skips avatars when the workspace has no Clerk org', async () => {
    await upsertContactsFromMailMessage(env, 'ws_1', null, message);

    expect(upsertMailContacts).toHaveBeenCalledWith({}, { tenant: true }, 'ws_1', message);
  });

  it('swallows a tenant DB failure', async () => {
    getTenantDbForWorkspaceById.mockRejectedValueOnce(new Error('no tenant'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(upsertContactsFromMailMessage(env, 'ws_1', 'org_1', message)).resolves.toBeUndefined();
    expect(upsertMailContacts).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
