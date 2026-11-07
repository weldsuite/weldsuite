/**
 * The wallet side of `POST /releases/:id/generate-notes`: an empty wallet is a
 * 402 before the model is called, and a served call is charged once for the
 * model that served it. The billing module is replaced here (the wallet lives
 * in the master database); the AI gateway HTTP is stubbed by URL and method.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@weldsuite/worker-kit/db';
import type { MergeReleaseDetailDto } from '@weldsuite/app-api-client/schemas/weldmerge-across';

const METERING = { masterDb: {}, internalWsId: 'ws_alpha', userId: 'user_alice' };
let emptyWallet = false;
const chargeAiUsage = vi.fn(async (..._args: unknown[]) => 3);

vi.mock('@weldsuite/core-domain/ai-billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/core-domain/ai-billing')>();
  return {
    ...actual,
    resolveAiMetering: async () => METERING,
    assertAiCredits: async () => {
      if (emptyWallet) throw new actual.InsufficientAiCreditsError(0, 1, 1);
    },
    chargeAiUsage: (...args: unknown[]) => chargeAiUsage(...args),
  };
});

import releasesRoutes from './index';
import { ADMIN, jsonInit, makeApp, ok, openDb, perRun, resetTables, stubGithub } from '../../test/helpers';
import { seedConnection, seedPullRequest, seedRepository, seedTeam } from '../../test/seed';

let db: Database;

beforeAll(async () => {
  db = await openDb();
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
  emptyWallet = false;
  chargeAiUsage.mockClear();
});

const BASE = '/api/merge/releases';
const AI_CALL = { method: 'POST', url: '/v1/acct_test/default/compat/chat/completions' };
const completion = {
  id: 'chatcmpl_1',
  object: 'chat.completion',
  created: 1_790_000_000,
  model: 'anthropic/claude-sonnet-4-5',
  choices: [{ index: 0, message: { role: 'assistant', content: '- Fixed tabs' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
};

async function releaseWithPullRequest() {
  const team = await seedTeam(db);
  const connection = await seedConnection(db);
  const repository = await seedRepository(db, connection.id, { teamId: team.id });
  await seedPullRequest(db, repository.id, 1, { state: 'merged', mergedAt: new Date('2026-11-01T10:00:00Z'), title: 'Fix tabs' });
  const app = makeApp(db, BASE, releasesRoutes, { grants: ADMIN, env: { CF_ACCOUNT_ID: 'acct_test', AI_GATEWAY_API_TOKEN: 'cf_token' } });
  const release = await ok<MergeReleaseDetailDto>(
    await app.request(BASE, jsonInit({ teamId: team.id, repositoryId: repository.id, name: 'Autumn' })),
    201,
  );
  stubGithub({});
  await ok(await app.request(`${BASE}/${release.id}/refresh`, jsonInit({})));
  return { app, release };
}

describe('generate-notes and the wallet', () => {
  it('is 402 with the shortfall before the model is called when the wallet is empty', async () => {
    const { app, release } = await releaseWithPullRequest();
    emptyWallet = true;
    const calls = stubGithub({ [`${AI_CALL.method} ${AI_CALL.url}`]: completion });

    const res = await app.request(`${BASE}/${release.id}/generate-notes`, jsonInit({}));
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      error: { code: 'INSUFFICIENT_CREDITS', details: { currentBalance: 0, required: 1, shortfall: 1 } },
    });
    expect(calls).toEqual([]);
    expect(chargeAiUsage).not.toHaveBeenCalled();
  });

  it('charges the call once, for the model that served it', async () => {
    const { app, release } = await releaseWithPullRequest();
    const calls = stubGithub({ [`${AI_CALL.method} ${AI_CALL.url}`]: completion });

    await ok(await app.request(`${BASE}/${release.id}/generate-notes`, jsonInit({})));
    expect(calls).toEqual(perRun([AI_CALL]));
    expect(chargeAiUsage).toHaveBeenCalledTimes(1);
    expect(chargeAiUsage.mock.calls[0]![0]).toBe(METERING);
    expect(chargeAiUsage.mock.calls[0]![1]).toMatchObject({
      op: 'merge_release_notes',
      referenceId: release.id,
      modelId: expect.stringContaining('anthropic/'),
      usage: expect.objectContaining({ inputTokens: 100, outputTokens: 20 }),
    });
  });
});
