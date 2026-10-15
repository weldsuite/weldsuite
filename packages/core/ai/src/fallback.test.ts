import { APICallError, generateText, simulateReadableStream, streamText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';

import { resolveConfig } from './config.js';
import { billedModelId, fallbackModelFor, isProviderRefusal, withModelFallback } from './fallback.js';
import { isByokModel } from './model-map.js';
import { rejectsSamplingParams, withSupportedSampling } from './sampling.js';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function answering(text: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    }),
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: text },
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ],
      }),
    }),
  });
}

function refusing(error: unknown) {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw error;
    },
    doStream: async () => {
      throw error;
    },
  });
}

function apiError(statusCode: number, message: string) {
  return new APICallError({
    message,
    url: 'https://gateway.ai.cloudflare.com/v1/acct/gw/compat/chat/completions',
    requestBodyValues: {},
    statusCode,
    isRetryable: false,
  });
}

const creditError = apiError(400, 'Your credit balance is too low to access the Anthropic API.');

const ids = { primaryId: 'anthropic/claude-sonnet-5-5', fallbackId: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' };

describe('isProviderRefusal', () => {
  it('treats credit, auth, rate-limit and provider errors as refusals', () => {
    expect(isProviderRefusal(creditError)).toBe(true);
    expect(isProviderRefusal(apiError(401, 'invalid x-api-key'))).toBe(true);
    expect(isProviderRefusal(apiError(429, 'rate limited'))).toBe(true);
    expect(isProviderRefusal(apiError(529, 'overloaded'))).toBe(true);
  });

  it('does not fall back on a malformed request', () => {
    expect(isProviderRefusal(apiError(400, 'messages: field required'))).toBe(false);
    expect(isProviderRefusal(new Error('boom'))).toBe(false);
  });
});

describe('withModelFallback', () => {
  it('answers from the primary model when it works', async () => {
    const model = withModelFallback({ primary: answering('primary'), fallback: answering('fallback'), ...ids });
    const res = await generateText({ model, prompt: 'hi' });
    expect(res.text).toBe('primary');
    expect(billedModelId(ids.primaryId, res)).toBe(ids.primaryId);
  });

  it('re-runs a refused call on the fallback model and bills that model', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const model = withModelFallback({ primary: refusing(creditError), fallback: answering('fallback'), ...ids });
    const res = await generateText({ model, prompt: 'hi', maxRetries: 0 });
    expect(res.text).toBe('fallback');
    expect(billedModelId(ids.primaryId, res)).toBe(ids.fallbackId);
    warn.mockRestore();
  });

  it('falls back for streaming calls too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const model = withModelFallback({ primary: refusing(creditError), fallback: answering('streamed'), ...ids });
    let finished: Parameters<typeof billedModelId>[1];
    const result = streamText({
      model,
      prompt: 'hi',
      maxRetries: 0,
      onFinish: (event) => {
        finished = event;
      },
    });
    let text = '';
    for await (const chunk of result.textStream) text += chunk;
    expect(text).toBe('streamed');
    expect(billedModelId(ids.primaryId, finished)).toBe(ids.fallbackId);
    warn.mockRestore();
  });

  it('rethrows errors that are not provider refusals', async () => {
    const bad = apiError(400, 'messages: field required');
    const model = withModelFallback({ primary: refusing(bad), fallback: answering('fallback'), ...ids });
    await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toThrow('field required');
  });
});

describe('fallbackModelFor', () => {
  it('only gives third-party chat models a fallback', () => {
    expect(fallbackModelFor({}, 'anthropic/claude-sonnet-5-5')).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    expect(fallbackModelFor({}, '@cf/meta/llama-3.1-8b-instruct-fast')).toBeNull();
    expect(fallbackModelFor({}, 'typesafe/jev')).toBeNull();
    expect(fallbackModelFor({ fallbackModel: null }, 'anthropic/claude-sonnet-5-5')).toBeNull();
  });
});

describe('withSupportedSampling', () => {
  it('drops sampling parameters for Claude 5 models only', async () => {
    expect(rejectsSamplingParams('anthropic/claude-sonnet-5-5')).toBe(true);
    expect(rejectsSamplingParams('anthropic/claude-haiku-5-5')).toBe(true);
    expect(rejectsSamplingParams('anthropic/claude-opus-4-8')).toBe(true);
    expect(rejectsSamplingParams('anthropic/claude-sonnet-4-5')).toBe(false);
    expect(rejectsSamplingParams('@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toBe(false);

    const inner = answering('ok');
    await generateText({
      model: withSupportedSampling(inner, 'anthropic/claude-sonnet-5-5'),
      prompt: 'hi',
      temperature: 0.7,
    });
    expect(inner.doGenerateCalls[0]?.temperature).toBeUndefined();

    const untouched = answering('ok');
    await generateText({
      model: withSupportedSampling(untouched, 'anthropic/claude-sonnet-4-5'),
      prompt: 'hi',
      temperature: 0.7,
    });
    expect(untouched.doGenerateCalls[0]?.temperature).toBe(0.7);
  });
});

describe('BYOK config', () => {
  it('reads AI_BYOK_PROVIDERS and AI_FALLBACK_MODEL', () => {
    const config = resolveConfig({
      CF_ACCOUNT_ID: 'acct',
      AI_BYOK_PROVIDERS: 'Anthropic, openai',
      AI_FALLBACK_MODEL: 'none',
    });
    expect(config.byokProviders).toEqual(['anthropic', 'openai']);
    expect(config.fallbackModel).toBeNull();
    expect(isByokModel(config, 'anthropic/claude-sonnet-5-5')).toBe(true);
    expect(isByokModel(config, '@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toBe(false);
    expect(isByokModel(config, 'google-ai-studio/gemini-2.5-flash')).toBe(false);
  });
});
