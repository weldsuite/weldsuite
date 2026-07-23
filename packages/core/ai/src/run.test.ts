import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { APICallError } from 'ai';

import { UnsupportedModelError } from './adapters/types.js';
import { AllGatewaysFailedError } from './errors.js';
import { runWithFallback, pickGateway, type GatewayUsageRecord } from './run.js';
import { thirdParty, workersAi } from './models.js';

const CF_ENV = { CF_ACCOUNT_ID: 'acct_test', AI_GATEWAY_API_TOKEN: 'cf_token' };
const COST_ENV = { ...CF_ENV, AI_GATEWAY_ROUTING: 'cost' };

function apiError(statusCode: number) {
  return new APICallError({
    message: `status ${statusCode}`,
    url: 'https://gateway.test',
    requestBodyValues: {},
    statusCode,
  });
}

const RESULT = { text: 'ok', usage: { inputTokens: 1000, outputTokens: 1000 } };

beforeEach(() => {
  // The path logs auth/billing failures loudly by design.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('runWithFallback — happy path', () => {
  it('serves from cloudflare and reports which gateway won', async () => {
    const run = vi.fn().mockResolvedValue(RESULT);
    const res = await runWithFallback(CF_ENV, { modelId: thirdParty.anthropic.sonnet, op: 'test' }, run);

    expect(res.value).toBe(RESULT);
    expect(res.gateway).toBe('cloudflare');
    expect(run).toHaveBeenCalledTimes(1);
    expect(res.attempts).toEqual([expect.objectContaining({ gateway: 'cloudflare', ok: true })]);
  });

  it('hands the callback a ready-to-use model and the canonical id', async () => {
    const run = vi.fn().mockResolvedValue(RESULT);
    await runWithFallback(CF_ENV, { modelId: thirdParty.anthropic.sonnet, op: 'test' }, run);

    const attempt = run.mock.calls[0]![0];
    expect(attempt.modelId).toBe(thirdParty.anthropic.sonnet);
    expect(attempt.model).toBeDefined();
    expect(attempt.attemptIndex).toBe(0);
  });
});

describe('runWithFallback — single gateway, no fallback', () => {
  it('tries exactly once and surfaces AllGatewaysFailedError on a 503', async () => {
    const run = vi.fn().mockRejectedValue(apiError(503));
    await expect(
      runWithFallback(CF_ENV, { modelId: thirdParty.anthropic.sonnet, op: 'test' }, run),
    ).rejects.toBeInstanceOf(AllGatewaysFailedError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a terminal 400 — calls run exactly once', async () => {
    const run = vi.fn().mockRejectedValue(apiError(400));
    await expect(
      runWithFallback(CF_ENV, { modelId: thirdParty.anthropic.sonnet, op: 'test' }, run),
    ).rejects.toThrow(/status 400/);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('runWithFallback — no candidates', () => {
  it('throws before running anything when the gateway is not configured', async () => {
    const run = vi.fn();
    await expect(
      runWithFallback({}, { modelId: thirdParty.anthropic.sonnet, op: 'test' }, run),
    ).rejects.toThrow(UnsupportedModelError);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('onUsage', () => {
  const opts = (onUsage: (r: GatewayUsageRecord) => void) => ({
    modelId: thirdParty.anthropic.sonnet,
    op: 'ai_generate',
    onUsage,
  });

  it('fires exactly once, with the gateway that served the call', async () => {
    const onUsage = vi.fn();
    const run = vi.fn().mockResolvedValue(RESULT);
    await runWithFallback(CF_ENV, opts(onUsage), run);

    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0]![0]).toMatchObject({
      gateway: 'cloudflare',
      modelId: thirdParty.anthropic.sonnet,
      op: 'ai_generate',
    });
  });

  it('does not fire when the call fails', async () => {
    const onUsage = vi.fn();
    const run = vi.fn().mockRejectedValue(apiError(503));
    await runWithFallback(CF_ENV, opts(onUsage), run).catch(() => {});
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('never fails a successful call when it throws', async () => {
    const onUsage = vi.fn().mockRejectedValue(new Error('telemetry down'));
    const run = vi.fn().mockResolvedValue(RESULT);
    const res = await runWithFallback(CF_ENV, opts(onUsage), run);
    expect(res.value).toBe(RESULT);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/recording gateway usage failed/i),
      expect.anything(),
    );
  });

  it('reports $0 provider cost when service credit covered the call', async () => {
    const onUsage = vi.fn();
    const run = vi.fn().mockResolvedValue(RESULT);
    await runWithFallback(
      COST_ENV,
      {
        ...opts(onUsage),
        credits: [{ gateway: 'cloudflare', remainingNanoUsd: null, enabled: true, priority: 1 }],
      },
      run,
    );
    expect(onUsage.mock.calls[0]![0]).toMatchObject({
      gateway: 'cloudflare',
      providerCostUsd: 0,
      coveredByServiceCredit: true,
    });
  });

  it('applies the cloudflare fee to the recorded cost when not free', async () => {
    const onUsage = vi.fn();
    const run = vi.fn().mockResolvedValue(RESULT);
    // llama70bFast = $0.293/1M in, $2.253/1M out.
    await runWithFallback(
      CF_ENV,
      { modelId: workersAi.llama70bFast, op: 'ai_generate', onUsage },
      run,
    );
    const rec = onUsage.mock.calls[0]![0] as GatewayUsageRecord;
    expect(rec.gateway).toBe('cloudflare');
    expect(rec.coveredByServiceCredit).toBe(false);
    // (0.000293 + 0.002253) * 1.05
    expect(rec.providerCostUsd).toBeCloseTo((0.000293 + 0.002253) * 1.05, 10);
  });
});

describe('pickGateway', () => {
  it('returns a single routed attempt without fallback (stream-safe)', () => {
    const attempt = pickGateway(CF_ENV, { modelId: thirdParty.anthropic.sonnet });
    expect(attempt.model).toBeDefined();
    expect(attempt.gateway).toBe('cloudflare');
    expect(attempt.modelId).toBe(thirdParty.anthropic.sonnet);
  });

  it('throws when the gateway is not configured', () => {
    expect(() => pickGateway({}, { modelId: thirdParty.anthropic.sonnet })).toThrow(
      UnsupportedModelError,
    );
  });
});
