import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAiGenerate, handleAiClassify, AiInsufficientCreditsError } from './ai';
import { makeActionContext } from '../../test/ctx';

// Mock the AI SDK boundary (never hit a real gateway in unit tests).
const generateTextMock = vi.fn();
const generateObjectMock = vi.fn();
const modelMock = vi.fn((id: string) => ({ __model: id }));

vi.mock('@weldsuite/ai', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/ai')>('@weldsuite/ai');
  return {
    ...actual,
    // Stand in for the routing/fallback layer: resolve one gateway, hand the
    // callback a model, and report usage exactly as the real one does. The
    // routing itself is unit-tested in packages/core/ai (routing/run tests) — here we
    // only care that the handlers wire it up correctly.
    runWithFallback: vi.fn(
      async (
        _env: unknown,
        opts: { modelId: string; op: string; onUsage?: (r: unknown) => void },
        run: (a: unknown) => Promise<unknown>,
      ) => {
        const value = await run({
          ai: { model: modelMock },
          model: modelMock(opts.modelId),
          modelId: opts.modelId,
          gateway: 'cloudflare',
          attemptIndex: 0,
        });
        opts.onUsage?.({
          gateway: 'cloudflare',
          modelId: opts.modelId,
          nativeModelId: opts.modelId,
          usage: (value as { usage?: unknown }).usage,
          providerCostUsd: 0.001,
          coveredByServiceCredit: false,
          op: opts.op,
          attempts: [],
        });
        return { value, gateway: 'cloudflare', attempts: [] };
      },
    ),
    generateText: (...args: unknown[]) => generateTextMock(...args),
    generateObject: (...args: unknown[]) => generateObjectMock(...args),
  };
});

// Ops-ledger writes are a separate concern (unit-tested in packages/credits);
// stub them so these tests stay pure.
vi.mock('@weldsuite/credits/gateway-costs', () => ({
  recordProviderUsage: vi.fn(async () => 'apu_test'),
  nanoUsd: (usd: number) => Math.round(usd * 1e9),
}));
vi.mock('@weldsuite/credits/gateway-cache', () => ({
  readGatewayCreditSnapshot: vi.fn(async () => null),
  toCreditStates: () => [],
}));

// Mock the credit wallet boundary.
const checkCreditsMock = vi.fn();
const consumeCreditsMock = vi.fn();
const grantCreditsMock = vi.fn();
const resolveInternalWorkspaceIdMock = vi.fn();

vi.mock('@weldsuite/credits', () => ({
  checkCredits: (...args: unknown[]) => checkCreditsMock(...args),
  consumeCredits: (...args: unknown[]) => consumeCreditsMock(...args),
  grantCredits: (...args: unknown[]) => grantCreditsMock(...args),
  resolveInternalWorkspaceId: (...args: unknown[]) => resolveInternalWorkspaceIdMock(...args),
}));

// Mock the master-db resolver (workflow-worker's own db.ts).
vi.mock('../../db', () => ({
  getMasterDb: vi.fn(() => ({ __masterDb: true })),
}));

const GATEWAY_ENV = { DATABASE_URL_MASTER: 'postgres://master', CF_ACCOUNT_ID: 'acct_test' };

function ctxWithEnv(overrides: Parameters<typeof makeActionContext>[0] = {}) {
  return makeActionContext({ env: GATEWAY_ENV, ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveInternalWorkspaceIdMock.mockResolvedValue('ws_internal_1');
  checkCreditsMock.mockResolvedValue({ available: true, currentBalance: 100, required: 1, shortfall: 0 });
  consumeCreditsMock.mockResolvedValue({ ok: true, transactionId: 'ctx_1', newBalance: 99, duplicate: false });
  generateTextMock.mockResolvedValue({
    text: 'hello there',
    finishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  });
  generateObjectMock.mockResolvedValue({
    object: { category: 'billing', confidence: 0.9, reasoning: 'mentions invoice' },
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
  });
});

describe('ai_generate', () => {
  it('throws when the prompt is missing', async () => {
    await expect(handleAiGenerate({}, ctxWithEnv())).rejects.toThrow(/prompt/i);
  });

  it('throws when the AI gateway is not configured', async () => {
    await expect(
      handleAiGenerate({ prompt: 'hi' }, makeActionContext({ env: { DATABASE_URL_MASTER: 'x' } })),
    ).rejects.toThrow(/gateway is not configured/i);
  });

  it('generates text, defaults to the recommended free draft model, and charges credits', async () => {
    const { recommended } = await import('@weldsuite/ai');
    const res = (await handleAiGenerate({ prompt: 'say hi' }, ctxWithEnv())) as {
      text: string;
      model: string;
      creditsUsed: number;
    };

    expect(res.text).toBe('hello there');
    expect(res.model).toBe(recommended.draft.free);
    expect(modelMock).toHaveBeenCalledWith(recommended.draft.free);
    expect(res.creditsUsed).toBeGreaterThan(0);
    expect(consumeCreditsMock).toHaveBeenCalledTimes(1);
    const chargeArgs = consumeCreditsMock.mock.calls[0][1];
    expect(chargeArgs.workspaceId).toBe('ws_internal_1');
    expect(chargeArgs.idempotencyKey).toBe('wf:wex_test:step_test:ai_generate');
  });

  it('accepts an explicit model + systemPrompt/system + maxTokens/max_tokens aliases', async () => {
    await handleAiGenerate(
      { prompt: 'hi', model: 'anthropic/claude-sonnet-4-5', system: 'be terse', max_tokens: 256 },
      ctxWithEnv(),
    );
    expect(modelMock).toHaveBeenCalledWith('anthropic/claude-sonnet-4-5');
    const callArgs = generateTextMock.mock.calls[0][0];
    expect(callArgs.system).toBe('be terse');
    expect(callArgs.maxOutputTokens).toBe(256);
  });

  it('throws AiInsufficientCreditsError (ai_insufficient_credits) when the wallet is empty', async () => {
    checkCreditsMock.mockResolvedValue({ available: false, currentBalance: 0, required: 1, shortfall: 1 });
    await expect(handleAiGenerate({ prompt: 'hi' }, ctxWithEnv())).rejects.toThrow(AiInsufficientCreditsError);
    await expect(handleAiGenerate({ prompt: 'hi' }, ctxWithEnv())).rejects.toMatchObject({
      code: 'ai_insufficient_credits',
    });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('runs unmetered (fail-open) when DATABASE_URL_MASTER is absent', async () => {
    const res = (await handleAiGenerate(
      { prompt: 'hi' },
      makeActionContext({ env: { CF_ACCOUNT_ID: 'acct_test' } }),
    )) as { creditsUsed: number };
    expect(res.creditsUsed).toBe(0);
    expect(checkCreditsMock).not.toHaveBeenCalled();
    expect(consumeCreditsMock).not.toHaveBeenCalled();
  });
});

describe('ai_classify', () => {
  it('requires text and a categories array', async () => {
    await expect(handleAiClassify({ categories: ['a'] }, ctxWithEnv())).rejects.toThrow(/text/i);
    await expect(handleAiClassify({ text: 'x' }, ctxWithEnv())).rejects.toThrow(/categories/i);
  });

  it('classifies text, defaults to the recommended free classify model, and charges credits', async () => {
    const { recommended } = await import('@weldsuite/ai');
    const res = (await handleAiClassify(
      { text: 'my invoice is wrong', categories: ['billing', 'support'] },
      ctxWithEnv(),
    )) as { category: string; confidence: number | null; model: string; creditsUsed: number };

    expect(res.category).toBe('billing');
    expect(res.confidence).toBe(0.9);
    expect(res.model).toBe(recommended.classify.free);
    expect(modelMock).toHaveBeenCalledWith(recommended.classify.free);
    expect(res.creditsUsed).toBeGreaterThan(0);
    const chargeArgs = consumeCreditsMock.mock.calls[0][1];
    expect(chargeArgs.idempotencyKey).toBe('wf:wex_test:step_test:ai_classify');
  });

  it('accepts the input/labels aliases', async () => {
    await handleAiClassify({ input: 'hello', labels: ['a', 'b'] }, ctxWithEnv());
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    const callArgs = generateObjectMock.mock.calls[0][0];
    expect(callArgs.prompt).toContain('a, b');
  });

  it('throws AiInsufficientCreditsError when the wallet is empty', async () => {
    checkCreditsMock.mockResolvedValue({ available: false, currentBalance: 0, required: 1, shortfall: 1 });
    await expect(
      handleAiClassify({ text: 'x', categories: ['a', 'b'] }, ctxWithEnv()),
    ).rejects.toThrow(AiInsufficientCreditsError);
    expect(generateObjectMock).not.toHaveBeenCalled();
  });
});
