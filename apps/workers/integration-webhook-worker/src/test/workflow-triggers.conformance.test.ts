/**
 * WeldConnect's integration-event receivers end to end, through the worker's
 * own `fetch`: Slack's app URL (`POST /integration-webhook/slack`, the team's
 * `slack_team:` KV entry), and the per-connection Twilio and GitHub URLs
 * (`/integration-webhook/twilio/:id`, `/github/:id`, the `intconn:` entry and
 * the connection's own secret). A matching active workflow gets a run on the
 * `EXECUTE_WORKFLOW` binding (the trigger index, its pinned connection and
 * filters). Run on both backends by the `integrations: workflow triggers`
 * conformance suite.
 */

import { createHmac } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@weldsuite/db/schema';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { conformanceTenantDb } from '@weldsuite/worker-kit/testing/conformance';
import { createWebhookTestApp } from './harness';

const holder = vi.hoisted(() => ({ tenantDb: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenantDb),
  getTenantDbForWorkspaceById: async () => conformanceTenantDb(holder.tenantDb),
}));

type Db = Awaited<ReturnType<typeof createPgliteDb>>['db'];
let tenantDb: Db;

const SLACK_SECRET = 'slack-signing-secret';
const TWILIO_TOKEN = 'twilio-auth-token';
const GITHUB_SECRET = 'github-hook-secret';

function memoryKv(seed: Record<string, string>) {
  const store = new Map(Object.entries(seed));
  return {
    get: async (key: string, type?: string) => {
      const value = store.get(key) ?? null;
      return type === 'json' && value !== null ? (JSON.parse(value) as unknown) : value;
    },
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  };
}

function runsBinding() {
  return {
    create: vi.fn(async () => ({ id: 'run' })),
    get: vi.fn(async () => ({})),
  };
}

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  holder.tenantDb = tenantDb;
}, 60_000);

beforeEach(async () => {
  await tenantDb.delete(schema.workflowTriggerIndex);
  await tenantDb.delete(schema.workflows);
  await tenantDb.delete(schema.workflowIntegrations);
  const workflow = (id: string, status = 'active') =>
    ({ id, name: `Workflow ${id}`, status, triggers: [] }) as unknown as typeof schema.workflows.$inferInsert;
  await tenantDb.insert(schema.workflows).values([workflow('wf_slack'), workflow('wf_filtered'), workflow('wf_paused', 'paused'), workflow('wf_sms'), workflow('wf_gh')]);
  const index = (id: string, workflowId: string, provider: string, event: string, extra: Record<string, unknown> = {}) =>
    ({
      id,
      workflowId,
      triggerId: `trg_${id}`,
      category: 'integration_event',
      provider,
      integrationEvent: event,
      ...extra,
    }) as typeof schema.workflowTriggerIndex.$inferInsert;
  await tenantDb.insert(schema.workflowTriggerIndex).values([
    index('wti_1', 'wf_slack', 'slack', 'slack.message'),
    index('wti_2', 'wf_filtered', 'slack', 'slack.message', { filters: [{ field: 'text', operator: 'contains', value: 'deploy' }] }),
    index('wti_3', 'wf_paused', 'slack', 'slack.message'),
    index('wti_4', 'wf_slack', 'slack', 'slack.slash_command', { integrationId: 'wfi_other' }),
    index('wti_5', 'wf_filtered', 'slack', 'slack.slash_command', { integrationId: 'wfi_slack' }),
    index('wti_6', 'wf_sms', 'twilio', 'twilio.inbound_sms', { filters: [{ field: 'from', operator: 'eq', value: '+15550001' }] }),
    index('wti_7', 'wf_gh', 'github', 'github.issue', { isEnabled: true }),
    index('wti_8', 'wf_gh', 'github', 'github.pull_request', { isEnabled: false }),
  ]);
  const integration = (id: string, type: string, credentials: Record<string, unknown>) =>
    ({ id, name: type, type, status: 'connected', credentials }) as unknown as typeof schema.workflowIntegrations.$inferInsert;
  await tenantDb.insert(schema.workflowIntegrations).values([
    integration('wfi_twilio', 'twilio', { authToken: TWILIO_TOKEN }),
    integration('wfi_github', 'github', { webhookSecret: GITHUB_SECRET }),
  ]);
});

function app(runs = runsBinding(), env: Record<string, unknown> = {}) {
  return {
    runs,
    target: createWebhookTestApp({
      tenantDb,
      env: {
        SLACK_SIGNING_SECRET: SLACK_SECRET,
        EXECUTE_WORKFLOW: runs,
        WORKSPACE_CACHE: memoryKv({
          'slack_team:T1': JSON.stringify({ workspaceId: 'ws_wf', integrationId: 'wfi_slack' }),
          'intconn:wfi_twilio': JSON.stringify({ workspaceId: 'ws_wf', provider: 'twilio' }),
          'intconn:wfi_github': JSON.stringify({ workspaceId: 'ws_wf', provider: 'github' }),
          'intconn:wfi_gone': JSON.stringify({ workspaceId: 'ws_wf', provider: 'github' }),
        }),
        ...env,
      },
    }),
  };
}

function slackHeaders(body: string, contentType = 'application/json', secret = SLACK_SECRET) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  return { 'Content-Type': contentType, 'X-Slack-Request-Timestamp': timestamp, 'X-Slack-Signature': signature };
}

function postSlack(target: ReturnType<typeof app>['target'], payload: unknown, secret?: string) {
  const body = JSON.stringify(payload);
  return target.request('/integration-webhook/slack', { method: 'POST', body, headers: slackHeaders(body, 'application/json', secret) });
}

function runsOf(runs: ReturnType<typeof runsBinding>) {
  return runs.create.mock.calls
    .map((call) => (call as unknown as [{ params: { workflowId: string; triggerId?: string; triggerData: { event: string } } }])[0].params)
    .map((p) => `${p.workflowId}/${p.triggerId}/${p.triggerData.event}`)
    .sort();
}

describe('POST /integration-webhook/slack', () => {
  it('refuses a forged or stale signature, and answers the URL handshake', async () => {
    const { target } = app();
    const forged = await postSlack(target, { type: 'url_verification', challenge: 'c' }, 'wrong');
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ error: 'invalid signature' });

    const body = '{}';
    const stale = await target.request('/integration-webhook/slack', {
      method: 'POST',
      body,
      headers: { 'X-Slack-Request-Timestamp': '1000', 'X-Slack-Signature': `v0=${createHmac('sha256', SLACK_SECRET).update(`v0:1000:${body}`).digest('hex')}` },
    });
    expect(stale.status).toBe(401);

    const handshake = await postSlack(target, { type: 'url_verification', challenge: 'challenge-123' });
    expect(handshake.status).toBe(200);
    expect(await handshake.json()).toEqual({ challenge: 'challenge-123' });
  });

  it('dispatches a person’s message to the matching active workflows', async () => {
    const { target, runs } = app();
    const res = await postSlack(target, {
      type: 'event_callback',
      team_id: 'T1',
      event: { type: 'message', channel: 'C1', user: 'U1', text: 'please deploy now', ts: '1700000000.0001' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(runsOf(runs)).toEqual(['wf_filtered/trg_wti_2/slack.message', 'wf_slack/trg_wti_1/slack.message']);

    const quiet = app();
    await postSlack(quiet.target, { type: 'event_callback', team_id: 'T1', event: { type: 'message', text: 'hello', user: 'U2' } });
    expect(runsOf(quiet.runs)).toEqual(['wf_slack/trg_wti_1/slack.message']);
  });

  it('ignores bots, edits, other events and teams it does not know', async () => {
    const { target, runs } = app();
    for (const payload of [
      { type: 'event_callback', team_id: 'T1', event: { type: 'message', bot_id: 'B1', text: 'deploy' } },
      { type: 'event_callback', team_id: 'T1', event: { type: 'message', subtype: 'message_changed' } },
      { type: 'event_callback', team_id: 'T1', event: { type: 'reaction_added' } },
      { type: 'event_callback', team_id: 'T9', event: { type: 'message', text: 'deploy' } },
      { type: 'block_actions' },
    ]) {
      const res = await postSlack(target, payload);
      expect(res.status).toBe(200);
    }
    expect(runs.create).not.toHaveBeenCalled();
  });

  it('dispatches a slash command to the triggers of its connection', async () => {
    const { target, runs } = app();
    const body = new URLSearchParams({ command: '/deploy', text: 'prod', user_id: 'U1', channel_id: 'C1', team_id: 'T1' }).toString();
    const res = await target.request('/integration-webhook/slack', {
      method: 'POST',
      body,
      headers: slackHeaders(body, 'application/x-www-form-urlencoded'),
    });
    expect(res.status).toBe(200);
    expect(runsOf(runs)).toEqual(['wf_filtered/trg_wti_5/slack.slash_command']);
    const [options] = runs.create.mock.calls[0] as unknown as [{ params: Record<string, unknown> }];
    expect(options.params).toEqual({
      workspaceId: 'ws_wf',
      userId: 'system',
      workflowId: 'wf_filtered',
      triggerId: 'trg_wti_5',
      triggerType: 'integration_event',
      triggerData: {
        eventType: 'slack.slash_command',
        provider: 'slack',
        event: 'slack.slash_command',
        integrationId: 'wfi_slack',
        data: { command: '/deploy', text: 'prod', user_id: 'U1', channel_id: 'C1', team_id: 'T1' },
      },
      source: 'integration',
    });
  });
});

describe('POST /integration-webhook/twilio/:connectionId', () => {
  const URL_PATH = '/integration-webhook/twilio/wfi_twilio';

  function sign(params: Record<string, string>, token = TWILIO_TOKEN) {
    const data = Object.keys(params)
      .sort()
      .reduce((acc, key) => acc + key + params[key], `http://localhost${URL_PATH}`);
    return createHmac('sha1', token).update(data).digest('base64');
  }

  function postSms(target: ReturnType<typeof app>['target'], params: Record<string, string>, signature = sign(params), path = URL_PATH) {
    return target.request(path, {
      method: 'POST',
      body: new URLSearchParams(params).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature, 'X-Forwarded-Host': 'localhost' },
    });
  }

  it('refuses an unknown connection and a wrong signature', async () => {
    const { target } = app();
    const unknown = await postSms(target, { From: '+1' }, 'x', '/integration-webhook/twilio/wfi_nowhere');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'unknown connection' });
    const forged = await postSms(target, { From: '+1', Body: 'hi' }, sign({ From: '+1', Body: 'hi' }, 'wrong'));
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ error: 'invalid signature' });
  });

  it('answers empty TwiML and dispatches an inbound SMS that matches', async () => {
    const { target, runs } = app();
    const res = await postSms(target, { From: '+15550001', To: '+15550002', Body: 'hello', MessageSid: 'SM1' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/xml');
    expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(runsOf(runs)).toEqual(['wf_sms/trg_wti_6/twilio.inbound_sms']);

    const other = app();
    const unmatched = await postSms(other.target, { From: '+15559999', Body: 'x' });
    expect(unmatched.status).toBe(200);
    const statusCallback = await postSms(other.target, { MessageStatus: 'delivered' });
    expect(statusCallback.status).toBe(200);
    expect(other.runs.create).not.toHaveBeenCalled();
  });
});

describe('POST /integration-webhook/github/:connectionId', () => {
  function postGithub(target: ReturnType<typeof app>['target'], event: string, payload: unknown, secret = GITHUB_SECRET, id = 'wfi_github') {
    const body = JSON.stringify(payload);
    return target.request(`/integration-webhook/github/${id}`, {
      method: 'POST',
      body,
      headers: { 'X-GitHub-Event': event, 'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` },
    });
  }

  it('answers a ping, and refuses an unknown connection and a wrong signature', async () => {
    const { target } = app();
    const ping = await postGithub(target, 'ping', { zen: 'z' }, 'any', 'wfi_nowhere');
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ ok: true });
    const unknown = await postGithub(target, 'issues', {}, GITHUB_SECRET, 'wfi_nowhere');
    expect(unknown.status).toBe(404);
    const gone = await postGithub(target, 'issues', {}, GITHUB_SECRET, 'wfi_gone');
    expect(gone.status).toBe(404);
    const forged = await postGithub(target, 'issues', { action: 'opened' }, 'wrong');
    expect(forged.status).toBe(401);
  });

  it('dispatches issue events, not disabled or unknown ones', async () => {
    const { target, runs } = app();
    const issue = await postGithub(target, 'issues', {
      action: 'opened',
      issue: { number: 12, title: 'Crash', state: 'open' },
      repository: { full_name: 'acme/app' },
    });
    expect(issue.status).toBe(200);
    expect(await issue.json()).toEqual({ ok: true });
    const pr = await postGithub(target, 'pull_request', { action: 'closed', pull_request: { number: 3, merged: true } });
    expect(pr.status).toBe(200);
    const push = await postGithub(target, 'push', { ref: 'refs/heads/main' });
    expect(push.status).toBe(200);
    expect(runsOf(runs)).toEqual(['wf_gh/trg_wti_7/github.issue']);
  });
});
