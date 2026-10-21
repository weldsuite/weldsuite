import { afterEach, describe, it, expect, vi } from 'vitest';
import { embed, generateText } from 'ai';

import {
  createCloudflareAdapter,
  DEFAULT_GATEWAY_ID,
  flattenWorkersAiRequestBody,
  toGatewayModelId,
} from './cloudflare.js';
import {
  anthropicBaseUrl,
  compatBaseUrl,
  restApiBaseUrl,
  type CloudflareGatewayConfig,
} from '../config.js';

describe('toGatewayModelId', () => {
  it('prefixes Workers AI ids with workers-ai/', () => {
    expect(toGatewayModelId('@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toBe(
      'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    );
  });

  it('leaves already provider-prefixed ids untouched', () => {
    expect(toGatewayModelId('anthropic/claude-sonnet-5-5')).toBe('anthropic/claude-sonnet-5-5');
    expect(toGatewayModelId('openai/gpt-5')).toBe('openai/gpt-5');
  });
});

describe('flattenWorkersAiRequestBody', () => {
  it('flattens OpenAI content-part arrays to plain strings', () => {
    const out = flattenWorkersAiRequestBody({
      model: 'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'You are helpful.' }] },
        { role: 'user', content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'there' }] },
        { role: 'assistant', content: 'Already a string' },
      ],
    });

    expect(out.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello\nthere' },
      { role: 'assistant', content: 'Already a string' },
    ]);
  });

  it('replaces null/undefined content with empty string', () => {
    const out = flattenWorkersAiRequestBody({
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: '1' }] },
        { role: 'tool', content: undefined },
      ],
    });

    expect(out.messages).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ id: '1' }] },
      { role: 'tool', content: '' },
    ]);
  });

  it('leaves non-message payloads untouched', () => {
    const body = { input: 'embed me' };
    expect(flattenWorkersAiRequestBody(body)).toEqual(body);
  });
});

describe('createCloudflareAdapter', () => {
  const base: CloudflareGatewayConfig = {
    provider: 'cloudflare',
    accountId: 'acct_1',
    apiKey: 'cf_token',
    defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  };

  it('builds language + embedding models', () => {
    const a = createCloudflareAdapter(base);
    expect(a.languageModel('@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toBeDefined();
    expect(a.textEmbeddingModel('@cf/baai/bge-m3')).toBeDefined();
  });

  describe('requests', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** Stub fetch, run one call, and return the request it sent. */
    async function capture(run: () => Promise<unknown>) {
      const sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL, init?: RequestInit) => {
          sent.push({
            url: String(url),
            headers: new Headers(init?.headers),
            body: JSON.parse(String(init?.body)),
          });
          const isEmbedding = String(url).endsWith('/embeddings');
          return new Response(
            JSON.stringify(
              isEmbedding
                ? { data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 1 } }
                : {
                    id: 'c1',
                    created: 0,
                    model: 'm',
                    choices: [
                      { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
                    ],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                  },
            ),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }),
      );
      await run();
      expect(sent).toHaveLength(1);
      const [req] = sent;
      if (!req) throw new Error('no request sent');
      return req;
    }

    it("sends chat models through the account's default gateway when CF_AI_GATEWAY is unset", async () => {
      const a = createCloudflareAdapter(base);
      const req = await capture(() =>
        generateText({ model: a.languageModel('anthropic/claude-sonnet-5-5'), prompt: 'hi' }),
      );
      expect(req.url).toBe(`${compatBaseUrl('acct_1', DEFAULT_GATEWAY_ID)}/chat/completions`);
      expect(req.body.model).toBe('anthropic/claude-sonnet-5-5');
      // The AI token authenticates the gateway; no provider Authorization header.
      expect(req.headers.get('cf-aig-authorization')).toBe('Bearer cf_token');
      expect(req.headers.get('authorization')).toBeNull();
    });

    it('prefixes Workers AI models on the gateway', async () => {
      const a = createCloudflareAdapter(base);
      const req = await capture(() =>
        generateText({ model: a.languageModel('@cf/meta/llama-3.3-70b-instruct-fp8-fast'), prompt: 'hi' }),
      );
      expect(req.body.model).toBe('workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    });

    it('uses CF_AI_GATEWAY and prefers CF_AIG_TOKEN when set', async () => {
      const a = createCloudflareAdapter({ ...base, gateway: 'weldsuite', gatewayToken: 'aig_tok' });
      const req = await capture(() =>
        generateText({ model: a.languageModel('anthropic/claude-sonnet-5-5'), prompt: 'hi' }),
      );
      expect(req.url).toBe(`${compatBaseUrl('acct_1', 'weldsuite')}/chat/completions`);
      expect(req.headers.get('cf-aig-authorization')).toBe('Bearer aig_tok');
    });

    it('sends native Anthropic models to the gateway Messages endpoint, PDF intact', async () => {
      const sent: { url: string; headers: Headers; body: Record<string, any> }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL, init?: RequestInit) => {
          sent.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
          return new Response(
            JSON.stringify({
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'claude-haiku-5-5',
              content: [{ type: 'text', text: '{}' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 2 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }),
      );
      const a = createCloudflareAdapter(base);
      await generateText({
        model: a.nativeLanguageModel('anthropic/claude-haiku-5-5'),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'file', mediaType: 'application/pdf', data: new TextEncoder().encode('%PDF-1.7') },
              { type: 'text', text: 'Read this' },
            ],
          },
        ],
      });

      expect(sent).toHaveLength(1);
      const [req] = sent;
      if (!req) throw new Error('no request sent');
      expect(req.url).toBe(`${anthropicBaseUrl('acct_1', DEFAULT_GATEWAY_ID)}/messages`);
      expect(req.body.model).toBe('claude-haiku-5-5');
      // The gateway pays with its stored key: no provider key leaves the Worker.
      expect(req.headers.get('x-api-key')).toBeNull();
      expect(req.headers.get('cf-aig-authorization')).toBe('Bearer cf_token');
      const [doc] = req.body.messages[0].content;
      expect(doc.type).toBe('document');
      expect(doc.source.media_type).toBe('application/pdf');
    });

    it('has no native route for models other than Anthropic', () => {
      const a = createCloudflareAdapter(base);
      expect(() => a.nativeLanguageModel('openai/gpt-5')).toThrow(/native route/);
    });

    it('keeps embeddings on the direct Workers AI endpoint', async () => {
      const a = createCloudflareAdapter(base);
      const req = await capture(() =>
        embed({ model: a.textEmbeddingModel('@cf/baai/bge-m3'), value: 'hi' }),
      );
      expect(req.url).toBe(`${restApiBaseUrl('acct_1')}/embeddings`);
      expect(req.headers.get('authorization')).toBe('Bearer cf_token');
    });
  });

  it('exposes the expected base-url helpers', () => {
    expect(restApiBaseUrl('acct_1')).toBe('https://api.cloudflare.com/client/v4/accounts/acct_1/ai/v1');
    expect(compatBaseUrl('acct_1', 'weldsuite')).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct_1/weldsuite/compat',
    );
  });
});
