/**
 * PUT /api/desk/phone/routes on pglite for the queue actions: `agents`,
 * `voicemail` and `menu`, their `options`, what is dropped because the action
 * does not use it, and what is refused (ranges, texts, menu shape, teams and
 * voice agents that do not exist).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  DESK_PHONE_MENU_ACTIONS as DB_MENU_ACTIONS,
  DESK_PHONE_MENU_DIGITS as DB_MENU_DIGITS,
  DESK_PHONE_ROUTE_ACTIONS as DB_ROUTE_ACTIONS,
  DESK_PHONE_UNANSWERED_ACTIONS as DB_UNANSWERED_ACTIONS,
} from '@weldsuite/db/schema/desk-phone-routes';
import {
  DESK_PHONE_MENU_ACTIONS,
  DESK_PHONE_MENU_DIGITS,
  DESK_PHONE_ROUTE_ACTIONS,
  DESK_PHONE_UNANSWERED_ACTIONS,
} from '@weldsuite/core-api-client/schemas/desk-phone';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { deskPhoneRoutes } from './index';

const NUMBER = 'vpn_ro_main';

let db: Database;

function put(body: Record<string, unknown>, grants = ['settings:manage', 'conversations:read']) {
  const { request } = createTestApp('/api/desk/phone', deskPhoneRoutes, {
    context: { tenantDb: db, permissions: permissions(...grants) },
  });
  return request('/api/desk/phone/routes', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voipPhoneNumberId: NUMBER, ...body }),
  });
}

const menu = (extra: Record<string, unknown> = {}) => ({
  prompt: 'Press 1 for sales, 2 for support.',
  choices: [
    { digit: '1', label: 'Sales', action: 'agents', departmentId: 'dept_ro_sales' },
    { digit: '2', label: 'Support', action: 'ai_agent', voiceAgentId: 'dva_ro_on' },
  ],
  fallbackDigit: '1',
  ...extra,
});

async function ok(body: Record<string, unknown>) {
  const res = await put(body);
  expect([200, 201]).toContain(res.status);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}
const statusOf = async (body: Record<string, unknown>) => (await put(body)).status;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.voipPhoneNumbers).values({ id: NUMBER, provider: 'telnyx', phoneNumber: '+31201290001', countryCode: 'NL', status: 'active' });
  await db.insert(schema.helpdeskDepartments).values({ id: 'dept_ro_sales', name: 'Sales', agentIds: ['user_a'] });
  await db.insert(schema.deskVoiceAgents).values([
    { id: 'dva_ro_on', name: 'On', systemPrompt: 'x', telnyxAssistantId: 'asst-on' },
    { id: 'dva_ro_off', name: 'Off', systemPrompt: 'x', enabled: false },
  ]);
}, 180_000);

describe('the action lists', () => {
  it('match the database schema', () => {
    expect([...DESK_PHONE_ROUTE_ACTIONS]).toEqual([...DB_ROUTE_ACTIONS]);
    expect([...DESK_PHONE_MENU_ACTIONS]).toEqual([...DB_MENU_ACTIONS]);
    expect([...DESK_PHONE_MENU_DIGITS]).toEqual([...DB_MENU_DIGITS]);
    expect([...DESK_PHONE_UNANSWERED_ACTIONS]).toEqual([...DB_UNANSWERED_ACTIONS]);
  });
});

describe('the agents action', () => {
  it('takes no options', async () => {
    expect(await ok({ action: 'agents' })).toMatchObject({ action: 'agents', options: null, voiceAgentId: null, forwardToE164: null });
  });

  it('keeps the options it uses and drops the rest', async () => {
    const data = await ok({
      action: 'agents',
      voiceAgentId: 'dva_ro_on',
      forwardToE164: '+31612349000',
      options: {
        greeting: 'Welcome.',
        language: 'nl-NL',
        departmentId: 'dept_ro_sales',
        ringSeconds: 30,
        maxWaitSeconds: 600,
        whenUnanswered: 'hangup',
        voicemailGreeting: 'Leave a message.',
        menu: menu(),
      },
    });
    expect(data).toMatchObject({ voiceAgentId: null, forwardToE164: null });
    expect(data.options).toEqual({
      greeting: 'Welcome.',
      language: 'nl-NL',
      departmentId: 'dept_ro_sales',
      ringSeconds: 30,
      maxWaitSeconds: 600,
      whenUnanswered: 'hangup',
      voicemailGreeting: 'Leave a message.',
    });
  });

  it('accepts the range limits and a null team', async () => {
    expect((await ok({ action: 'agents', options: { ringSeconds: 10, maxWaitSeconds: 30, departmentId: null } })).options).toEqual({
      ringSeconds: 10,
      maxWaitSeconds: 30,
    });
    expect((await ok({ action: 'agents', options: { ringSeconds: 60, maxWaitSeconds: 1800 } })).options).toEqual({
      ringSeconds: 60,
      maxWaitSeconds: 1800,
    });
  });

  it('refuses values out of range, texts too long and a bad language', async () => {
    expect(await statusOf({ action: 'agents', options: { ringSeconds: 9 } })).toBe(400);
    expect(await statusOf({ action: 'agents', options: { ringSeconds: 61 } })).toBe(400);
    expect(await statusOf({ action: 'agents', options: { ringSeconds: 12.5 } })).toBe(400);
    expect(await statusOf({ action: 'agents', options: { maxWaitSeconds: 29 } })).toBe(400);
    expect(await statusOf({ action: 'agents', options: { maxWaitSeconds: 1801 } })).toBe(400);
    expect(await statusOf({ action: 'agents', options: { greeting: 'x'.repeat(1001) } })).toBe(400);
    expect(await statusOf({ action: 'agents', options: { voicemailGreeting: 'x'.repeat(1001) } })).toBe(400);
    expect(await statusOf({ action: 'agents', options: { language: 'english please' } })).toBe(400);
    expect(await statusOf({ action: 'agents', options: { whenUnanswered: 'ring' } })).toBe(400);
    expect((await ok({ action: 'agents', options: { greeting: 'x'.repeat(1000) } })).options).toMatchObject({ greeting: 'x'.repeat(1000) });
  });

  it('needs the team to exist', async () => {
    const res = await put({ action: 'agents', options: { departmentId: 'dept_ro_missing' } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Team with ID 'dept_ro_missing' not found" } });
  });
});

describe('the voicemail action', () => {
  it('keeps its greeting and language only', async () => {
    const data = await ok({
      action: 'voicemail',
      options: { voicemailGreeting: 'After the beep.', language: 'en-GB', ringSeconds: 20, greeting: 'Hi', departmentId: 'dept_ro_sales' },
    });
    expect(data.options).toEqual({ voicemailGreeting: 'After the beep.', language: 'en-GB' });
  });
});

describe('the menu action', () => {
  it('needs a menu', async () => {
    expect(await statusOf({ action: 'menu' })).toBe(400);
    expect(await statusOf({ action: 'menu', options: {} })).toBe(400);
    expect(await statusOf({ action: 'menu', options: { language: 'en-US' } })).toBe(400);
  });

  it('stores the menu with the options it uses', async () => {
    const data = await ok({
      action: 'menu',
      options: { language: 'en-US', ringSeconds: 15, greeting: 'dropped', departmentId: 'dept_ro_sales', menu: menu() },
    });
    expect(data.options).toEqual({ language: 'en-US', ringSeconds: 15, menu: menu() });
    const listed = (await (await createTestApp('/api/desk/phone', deskPhoneRoutes, { context: { tenantDb: db, permissions: permissions('conversations:read') } }).request('/api/desk/phone/routes')).json()) as {
      data: Array<{ options: unknown }>;
    };
    expect(listed.data[0]!.options).toEqual(data.options);
  });

  it('cuts every choice down to the fields its action uses', async () => {
    const data = await ok({
      action: 'menu',
      options: {
        menu: {
          prompt: 'Pick.',
          choices: [
            { digit: '1', label: '  ', action: 'voicemail', voiceAgentId: 'dva_ro_on', forwardToE164: '+31612349000', departmentId: 'dept_ro_sales' },
            { digit: '#', label: 'Mobile', action: 'forward', forwardToE164: '+31612349000', voiceAgentId: null },
          ],
        },
      },
    });
    expect((data.options as { menu: unknown }).menu).toEqual({
      prompt: 'Pick.',
      choices: [
        { digit: '1', action: 'voicemail' },
        { digit: '#', label: 'Mobile', action: 'forward', forwardToE164: '+31612349000' },
      ],
    });
  });

  it('refuses a menu with the wrong shape', async () => {
    const choice = { digit: '1', action: 'voicemail' };
    expect(await statusOf({ action: 'menu', options: { menu: { prompt: '', choices: [choice] } } })).toBe(400);
    expect(await statusOf({ action: 'menu', options: { menu: { prompt: 'x'.repeat(1001), choices: [choice] } } })).toBe(400);
    expect(await statusOf({ action: 'menu', options: { menu: { prompt: 'Pick.', choices: [] } } })).toBe(400);
    const ten = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((digit) => ({ digit, action: 'voicemail' }));
    expect(await statusOf({ action: 'menu', options: { menu: { prompt: 'Pick.', choices: ten } } })).toBe(400);
    expect(await statusOf({ action: 'menu', options: { menu: { prompt: 'Pick.', choices: [choice, choice] } } })).toBe(400);
    expect(await statusOf({ action: 'menu', options: { menu: { prompt: 'Pick.', choices: [{ digit: 'A', action: 'voicemail' }] } } })).toBe(400);
    expect(await statusOf({ action: 'menu', options: { menu: { prompt: 'Pick.', choices: [{ digit: '1', action: 'hangup' }] } } })).toBe(400);
    expect(await statusOf({ action: 'menu', options: { menu: { prompt: 'Pick.', choices: [{ digit: '1', action: 'menu' }] } } })).toBe(400);
    expect(await statusOf({ action: 'menu', options: { menu: { prompt: 'Pick.', choices: [choice], fallbackDigit: '2' } } })).toBe(400);
    expect(await statusOf({ action: 'menu', options: { menu: { prompt: 'Pick.', choices: [{ digit: '1', action: 'ai_agent' }] } } })).toBe(400);
    expect(await statusOf({ action: 'menu', options: { menu: { prompt: 'Pick.', choices: [{ digit: '1', action: 'forward' }] } } })).toBe(400);
    expect(await statusOf({ action: 'menu', options: { menu: { prompt: 'Pick.', choices: [{ digit: '1', action: 'forward', forwardToE164: '0612345678' }] } } })).toBe(400);
  });

  it('accepts nine choices, and no fallback', async () => {
    const nine = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => ({ digit, action: 'voicemail' }));
    const data = await ok({ action: 'menu', options: { menu: { prompt: 'Pick.', choices: nine, fallbackDigit: null } } });
    expect((data.options as { menu: { choices: unknown[]; fallbackDigit?: unknown } }).menu.choices).toHaveLength(9);
    expect((data.options as { menu: { fallbackDigit?: unknown } }).menu.fallbackDigit).toBeUndefined();
  });

  it('needs the teams and voice agents it names to exist, and the agents to be enabled', async () => {
    const withChoice = (choice: Record<string, unknown>) => ({ action: 'menu', options: { menu: { prompt: 'Pick.', choices: [choice] } } });

    const team = await put(withChoice({ digit: '1', action: 'agents', departmentId: 'dept_ro_gone' }));
    expect(team.status).toBe(404);
    expect(await team.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Team with ID 'dept_ro_gone' not found" } });

    const missing = await put(withChoice({ digit: '1', action: 'ai_agent', voiceAgentId: 'dva_ro_gone' }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Voice agent with ID 'dva_ro_gone' not found" } });

    const off = await put(withChoice({ digit: '1', action: 'ai_agent', voiceAgentId: 'dva_ro_off' }));
    expect(off.status).toBe(400);
    expect(await off.json()).toMatchObject({ error: { code: 'BAD_REQUEST', message: 'Voice agent dva_ro_off is disabled' } });
  });
});

describe('the other actions', () => {
  it('store no options', async () => {
    expect(
      await ok({ action: 'forward', forwardToE164: '+31612349000', options: { greeting: 'Hi', ringSeconds: 20 } }),
    ).toMatchObject({ action: 'forward', forwardToE164: '+31612349000', options: null });
    expect(await ok({ action: 'hangup', options: { language: 'en-US' } })).toMatchObject({ action: 'hangup', options: null });
    expect(await ok({ action: 'ai_agent', voiceAgentId: 'dva_ro_on' })).toMatchObject({ action: 'ai_agent', voiceAgentId: 'dva_ro_on', options: null });
  });

  it('refuse an action that does not exist', async () => {
    expect(await statusOf({ action: 'queue' })).toBe(400);
  });

  it('need settings:manage', async () => {
    expect((await put({ action: 'agents' }, ['conversations:read'])).status).toBe(403);
  });
});
