import { describe, it, expect, vi } from 'vitest';
import { handleCreateContact, handleUpdateContact } from './crm';
import { makeActionContext } from '../../test/ctx';
import type { WorkflowEnv } from '../types';

function connectInternal(response: unknown, status = 200) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(response), { status }));
  return { env: { CONNECT_INTERNAL: { fetch } } as unknown as WorkflowEnv, fetch };
}

const owned = { workspaceId: 'ws_1', userId: 'system', ownerUserId: 'owner_1' };
const ok = { success: true, created: true, contact: { id: 'per_1', displayName: 'Ada Lovelace', email: 'ada@x.io' } };

describe('create_contact', () => {
  it('sends the contact with the owner as actor and returns its id', async () => {
    const { env, fetch } = connectInternal(ok);
    const res = await handleCreateContact(
      { firstName: ' Ada ', lastName: 'Lovelace', email: 'ada@x.io', tags: 'vip, , beta', phone: '' },
      makeActionContext({ env, tenant: owned, chainDepth: 2 }),
    );

    expect(res).toEqual({ contactId: 'per_1', name: 'Ada Lovelace', email: 'ada@x.io', created: true });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://internal/api/internal/workflow-actions/create-contact');
    expect(JSON.parse(String(init?.body))).toEqual({
      workspaceId: 'ws_1',
      ownerUserId: 'owner_1',
      triggeredBy: 'system',
      chainDepth: 2,
      skipIfEmailExists: true,
      contact: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.io', tags: ['vip', 'beta'] },
    });
  });

  it('fails without retrying when the run has no owner', async () => {
    const { env } = connectInternal(ok);
    await expect(
      handleCreateContact({ firstName: 'Ada' }, makeActionContext({ env, tenant: { workspaceId: 'ws_1', userId: 'u' } })),
    ).rejects.toMatchObject({ name: 'NonRetryableStepError', message: expect.stringMatching(/no owner/) });
  });

  it('needs a name or an email, and a valid email', async () => {
    const { env } = connectInternal(ok);
    await expect(handleCreateContact({ title: 'CTO' }, makeActionContext({ env, tenant: owned }))).rejects.toThrow(
      /name or an email/,
    );
    await expect(handleCreateContact({ email: 'nope' }, makeActionContext({ env, tenant: owned }))).rejects.toThrow(
      /not valid/,
    );
  });

  it("turns the owner's missing permission into a step failure that is not retried", async () => {
    const { env } = connectInternal(
      { success: false, error: "The workflow's owner doesn't have permission to create contacts (people:create)" },
      403,
    );
    await expect(handleCreateContact({ firstName: 'Ada' }, makeActionContext({ env, tenant: owned }))).rejects.toMatchObject({
      name: 'NonRetryableStepError',
      message: expect.stringMatching(/permission to create contacts/),
    });
  });
});

describe('update_contact', () => {
  it('sends only the filled-in fields', async () => {
    const { env, fetch } = connectInternal({ ...ok, created: undefined });
    await handleUpdateContact({ contactId: 'per_1', title: 'CTO', email: '' }, makeActionContext({ env, tenant: owned }));
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body.contactId).toBe('per_1');
    expect(body.contact).toEqual({ title: 'CTO' });
  });

  it('needs a contact and at least one field', async () => {
    const { env } = connectInternal(ok);
    await expect(handleUpdateContact({ title: 'x' }, makeActionContext({ env, tenant: owned }))).rejects.toThrow(/contact/);
    await expect(handleUpdateContact({ contactId: 'per_1' }, makeActionContext({ env, tenant: owned }))).rejects.toThrow(
      /at least one field/,
    );
  });
});
