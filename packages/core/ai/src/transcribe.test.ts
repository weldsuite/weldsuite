import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bytesToBase64,
  isTranscribeConfigured,
  parseTranscribeResponse,
  resolveTranscribeRequest,
  transcribeAudio,
  WHISPER_MODEL_ID,
} from './transcribe.js';
import type { CloudflareGatewayConfig } from './config.js';

const baseConfig = (overrides: Partial<CloudflareGatewayConfig> = {}): CloudflareGatewayConfig => ({
  provider: 'cloudflare',
  accountId: 'acct_test',
  defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveTranscribeRequest', () => {
  it('uses the REST run endpoint with the API token and gateway id', () => {
    const req = resolveTranscribeRequest(baseConfig({ apiKey: 'cf_token', gateway: 'weld' }));
    expect(req.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/acct_test/ai/run/${WHISPER_MODEL_ID}`,
    );
    expect(req.headers.Authorization).toBe('Bearer cf_token');
    expect(req.headers['cf-aig-gateway-id']).toBe('weld');
  });

  it('falls back to the gateway workers-ai route with only a gateway token', () => {
    const req = resolveTranscribeRequest(baseConfig({ gatewayToken: 'aig_tok' }));
    expect(req.url).toBe(
      `https://gateway.ai.cloudflare.com/v1/acct_test/default/workers-ai/${WHISPER_MODEL_ID}`,
    );
    expect(req.headers['cf-aig-authorization']).toBe('Bearer aig_tok');
  });

  it('throws when no credentials are available', () => {
    expect(() => resolveTranscribeRequest(baseConfig())).toThrow(/not configured/i);
  });
});

describe('isTranscribeConfigured', () => {
  it('is true with an AI binding and no tokens', () => {
    expect(isTranscribeConfigured({ AI: { run: vi.fn() } })).toBe(true);
  });

  it('is true with account id + API token', () => {
    expect(isTranscribeConfigured({ CF_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' })).toBe(true);
  });

  it('is false with neither', () => {
    expect(isTranscribeConfigured({ CF_ACCOUNT_ID: 'a' })).toBe(false);
  });
});

describe('parseTranscribeResponse', () => {
  it('parses the REST envelope with segments and transcription_info', () => {
    const parsed = parseTranscribeResponse({
      success: true,
      result: {
        text: ' Hello there. General Kenobi. ',
        word_count: 4,
        segments: [
          { start: 0, end: 1.5, text: ' Hello there.' },
          { start: 1.5, end: 3, text: ' General Kenobi.' },
          { start: 3, end: 3.1, text: '   ' },
        ],
        transcription_info: { language: 'en', duration: 3.1 },
      },
    });
    expect(parsed.text).toBe('Hello there. General Kenobi.');
    expect(parsed.wordCount).toBe(4);
    expect(parsed.segments).toEqual([
      { start: 0, end: 1.5, text: 'Hello there.' },
      { start: 1.5, end: 3, text: 'General Kenobi.' },
    ]);
    expect(parsed.language).toBe('en');
    expect(parsed.durationSeconds).toBe(3.1);
  });

  it('accepts the bare model output and derives text/word count from segments', () => {
    const parsed = parseTranscribeResponse({ segments: [{ start: 0, end: 1, text: 'one two' }] });
    expect(parsed.text).toBe('one two');
    expect(parsed.wordCount).toBe(2);
  });

  it('surfaces an API error envelope', () => {
    expect(() => parseTranscribeResponse({ success: false, errors: [{ code: 1, message: 'nope' }] })).toThrow(
      /Whisper API error/,
    );
  });

  it('rejects an empty body', () => {
    expect(() => parseTranscribeResponse(null)).toThrow(/empty body/);
  });
});

describe('bytesToBase64', () => {
  it('round-trips more bytes than one fromCharCode chunk', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
    const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (ch) => ch.charCodeAt(0));
    expect(decoded.length).toBe(bytes.length);
    expect(decoded[99_999]).toBe(bytes[99_999]);
  });
});

describe('transcribeAudio', () => {
  it('POSTs base64 audio with the language hint and parses the result', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ success: true, result: { text: 'hoi', segments: [{ start: 0, end: 1, text: 'hoi' }] } }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await transcribeAudio(
      baseConfig({ apiKey: 'cf_token' }),
      { audio: new Uint8Array([1, 2, 3]), language: 'nl' },
    );

    expect(result.text).toBe('hoi');
    expect(result.modelId).toBe(WHISPER_MODEL_ID);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.audio).toBe(bytesToBase64(new Uint8Array([1, 2, 3])));
    expect(body.language).toBe('nl');
    expect(body.task).toBe('transcribe');
  });

  it('prefers the AI binding when the worker has one', async () => {
    const run = vi.fn(async () => ({ text: 'hi', segments: [] }));
    const result = await transcribeAudio({ AI: { run }, CF_AI_GATEWAY: 'gw' }, { audio: new Uint8Array([9]) });
    expect(result.text).toBe('hi');
    expect(run).toHaveBeenCalledWith(WHISPER_MODEL_ID, expect.objectContaining({ task: 'transcribe' }), {
      gateway: { id: 'gw' },
    });
  });

  it('throws with the status on a non-2xx REST response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('too big', { status: 413 })));
    await expect(
      transcribeAudio(baseConfig({ apiKey: 't' }), { audio: new Uint8Array([1]) }),
    ).rejects.toThrow(/\(413\)/);
  });
});
