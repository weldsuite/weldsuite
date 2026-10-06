import { describe, it, expect, vi } from 'vitest';
import {
  handleCreateContact,
  handleUpdateContact,
  handleCreateLead,
  handleCreateDeal,
  handleMoveDealStage,
  handleLogActivity,
} from './crm';
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

describe('create_lead', () => {
  const leadOk = { success: true, lead: { id: 'lead_1', name: 'Ada Lovelace', email: 'ada@x.io' } };

  it('sends the lead with the owner as actor and returns its id', async () => {
    const { env, fetch } = connectInternal(leadOk);
    const res = await handleCreateLead(
      { firstName: ' Ada ', lastName: 'Lovelace', email: 'ada@x.io', companyName: 'Acme' },
      makeActionContext({ env, tenant: owned, chainDepth: 3 }),
    );

    expect(res).toEqual({ leadId: 'lead_1', name: 'Ada Lovelace', email: 'ada@x.io' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://internal/api/internal/workflow-actions/create-lead');
    expect(JSON.parse(String(init?.body))).toEqual({
      workspaceId: 'ws_1',
      ownerUserId: 'owner_1',
      triggeredBy: 'system',
      chainDepth: 3,
      lead: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.io', companyName: 'Acme' },
    });
  });

  it('needs an email, and a valid one', async () => {
    const { env } = connectInternal(leadOk);
    await expect(handleCreateLead({ firstName: 'Ada' }, makeActionContext({ env, tenant: owned }))).rejects.toThrow(
      /needs an email/,
    );
    await expect(handleCreateLead({ email: 'nope' }, makeActionContext({ env, tenant: owned }))).rejects.toThrow(
      /not valid/,
    );
  });

  it("turns the owner's missing permission into a step failure that is not retried", async () => {
    const { env } = connectInternal(
      { success: false, error: "The workflow's owner doesn't have permission to create leads (leads:create)" },
      403,
    );
    await expect(
      handleCreateLead({ email: 'ada@x.io' }, makeActionContext({ env, tenant: owned })),
    ).rejects.toMatchObject({ name: 'NonRetryableStepError', message: expect.stringMatching(/permission to create leads/) });
  });
});

describe('create_deal', () => {
  const dealOk = { success: true, deal: { id: 'opp_1', name: 'Acme Deal', stage: 'prospecting', status: 'open' } };

  it('sends the deal with the owner as actor and returns its id', async () => {
    const { env, fetch } = connectInternal(dealOk);
    const res = await handleCreateDeal(
      { name: 'Acme Deal', customerId: 'cust_1', amount: 5000, currency: 'EUR' },
      makeActionContext({ env, tenant: owned, chainDepth: 1 }),
    );

    expect(res).toEqual({ dealId: 'opp_1', name: 'Acme Deal', stage: 'prospecting', status: 'open' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://internal/api/internal/workflow-actions/create-deal');
    expect(JSON.parse(String(init?.body))).toEqual({
      workspaceId: 'ws_1',
      ownerUserId: 'owner_1',
      triggeredBy: 'system',
      chainDepth: 1,
      deal: { name: 'Acme Deal', customerId: 'cust_1', amount: 5000, currency: 'EUR' },
    });
  });

  it('needs a name and a company', async () => {
    const { env } = connectInternal(dealOk);
    await expect(handleCreateDeal({ customerId: 'cust_1' }, makeActionContext({ env, tenant: owned }))).rejects.toThrow(
      /needs a name/,
    );
    await expect(handleCreateDeal({ name: 'Acme Deal' }, makeActionContext({ env, tenant: owned }))).rejects.toThrow(
      /company this deal belongs to/,
    );
  });

  it("turns the owner's missing permission into a step failure that is not retried", async () => {
    const { env } = connectInternal(
      { success: false, error: "The workflow's owner doesn't have permission to create deals (opportunities:create)" },
      403,
    );
    await expect(
      handleCreateDeal({ name: 'Acme Deal', customerId: 'cust_1' }, makeActionContext({ env, tenant: owned })),
    ).rejects.toMatchObject({ name: 'NonRetryableStepError', message: expect.stringMatching(/permission to create deals/) });
  });
});

describe('move_deal_stage', () => {
  const moveOk = { success: true, deal: { id: 'opp_1', stageId: 'stg_won', status: 'won' } };

  it('sends dealId/stageId with the owner as actor and returns the result', async () => {
    const { env, fetch } = connectInternal(moveOk);
    const res = await handleMoveDealStage(
      { dealId: 'opp_1', stageId: 'stg_won' },
      makeActionContext({ env, tenant: owned, chainDepth: 2 }),
    );

    expect(res).toEqual({ dealId: 'opp_1', stageId: 'stg_won', status: 'won' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://internal/api/internal/workflow-actions/move-deal-stage');
    expect(JSON.parse(String(init?.body))).toEqual({
      workspaceId: 'ws_1',
      ownerUserId: 'owner_1',
      triggeredBy: 'system',
      chainDepth: 2,
      dealId: 'opp_1',
      stageId: 'stg_won',
    });
  });

  it('needs a deal and a target stage', async () => {
    const { env } = connectInternal(moveOk);
    await expect(handleMoveDealStage({ stageId: 'stg_won' }, makeActionContext({ env, tenant: owned }))).rejects.toThrow(
      /deal to move/,
    );
    await expect(handleMoveDealStage({ dealId: 'opp_1' }, makeActionContext({ env, tenant: owned }))).rejects.toThrow(
      /stage to move/,
    );
  });

  it('turns an unknown stage into a step failure that is not retried', async () => {
    const { env } = connectInternal({ success: false, error: 'Unknown pipeline stage stg_missing' }, 400);
    await expect(
      handleMoveDealStage({ dealId: 'opp_1', stageId: 'stg_missing' }, makeActionContext({ env, tenant: owned })),
    ).rejects.toMatchObject({ name: 'NonRetryableStepError', message: expect.stringMatching(/Unknown pipeline stage/) });
  });
});

describe('log_activity', () => {
  const activityOk = { success: true, activity: { id: 'act_1', type: 'call', subject: 'Discovery call' } };

  it('sends the activity with the owner as actor, defaulting type to note', async () => {
    const { env, fetch } = connectInternal(activityOk);
    const res = await handleLogActivity(
      { subject: 'Discovery call', type: 'call', personId: 'person_1' },
      makeActionContext({ env, tenant: owned, chainDepth: 1 }),
    );

    expect(res).toEqual({ activityId: 'act_1', type: 'call', subject: 'Discovery call' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://internal/api/internal/workflow-actions/log-activity');
    expect(JSON.parse(String(init?.body))).toEqual({
      workspaceId: 'ws_1',
      ownerUserId: 'owner_1',
      triggeredBy: 'system',
      chainDepth: 1,
      activity: { type: 'call', subject: 'Discovery call', personId: 'person_1' },
    });
  });

  it('defaults type to note when not given', async () => {
    const { env, fetch } = connectInternal(activityOk);
    await handleLogActivity({ subject: 'A note' }, makeActionContext({ env, tenant: owned }));
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body.activity.type).toBe('note');
  });

  it('needs a subject', async () => {
    const { env } = connectInternal(activityOk);
    await expect(handleLogActivity({ type: 'note' }, makeActionContext({ env, tenant: owned }))).rejects.toThrow(
      /needs a subject/,
    );
  });

  it("turns the owner's missing permission into a step failure that is not retried", async () => {
    const { env } = connectInternal(
      { success: false, error: "The workflow's owner doesn't have permission to log activities (activities:create)" },
      403,
    );
    await expect(
      handleLogActivity({ subject: 'A note' }, makeActionContext({ env, tenant: owned })),
    ).rejects.toMatchObject({ name: 'NonRetryableStepError', message: expect.stringMatching(/permission to log activities/) });
  });
});
