import { embed, generateObject, generateText, jsonSchema, streamText, tool } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODEL } from '../config.js';
import { evaluate } from '../evaluate.js';
import { createWeldAI } from '../gateway.js';
import { transcribeAudio } from '../transcribe.js';
import { createMockModel, MOCK_AI_BASE_URL, MOCK_AI_HOST } from './mock-model.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The worker env of a test that points `@weldsuite/ai` at the mock. */
function setup(options: Parameters<typeof createMockModel>[0] = {}) {
  const mock = createMockModel(options);
  vi.stubGlobal('fetch', mock.fetch);
  return { mock, ai: createWeldAI({ ...mock.env }) };
}

describe('AI_TEST_BASE_URL', () => {
  it("sends chat models to the mock's /chat/completions instead of the gateway", async () => {
    const { mock, ai } = setup();
    const { text, usage } = await generateText({ model: ai.model(), prompt: 'hi' });
    expect(text).toBe('ok');
    expect(usage.inputTokens).toBe(10);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.url).toBe(`${MOCK_AI_BASE_URL}/chat/completions`);
    expect(mock.calls[0]?.path).toBe('/chat/completions');
    expect((mock.calls[0]?.body as { model: string }).model).toBe(`workers-ai/${DEFAULT_MODEL}`);
  });

  it('sends embeddings and Anthropic’s Messages API there too', async () => {
    const { mock, ai } = setup({ chat: { text: 'native' }, embeddingDimensions: 8 });
    const { embedding } = await embed({ model: ai.embedding('@cf/baai/bge-m3'), value: 'hello' });
    expect(embedding).toHaveLength(8);
    const { text } = await generateText({ model: ai.nativeModel('anthropic/claude-haiku-5-5'), prompt: 'hi' });
    expect(text).toBe('native');
    expect(mock.calls.map((call) => call.path)).toEqual(['/embeddings', '/messages']);
    // The same text gets the same vector, run after run.
    const again = await embed({ model: ai.embedding('@cf/baai/bge-m3'), value: 'hello' });
    expect(again.embedding).toEqual(embedding);
  });

  it('sends Jev and Whisper runs to <base>/run', async () => {
    const { mock } = setup({
      jev: { billing: { answer: true } },
      transcription: { text: 'Hallo wereld.', language: 'nl' },
    });
    const env = { ...mock.env, AI_GATEWAY_API_TOKEN: 'never-sent' };
    const result = await evaluate(env, {
      state: 'Invoice overdue',
      questions: { billing: { type: 'noul', instructions: 'Is it about billing?' } },
    });
    expect(result.answers).toEqual({ billing: { answer: true } });
    const heard = await transcribeAudio(env, { audio: new Uint8Array([1, 2, 3]) });
    expect(heard.text).toBe('Hallo wereld.');
    expect(mock.calls.map((call) => call.path)).toEqual(['/run', '/run/@cf/openai/whisper-large-v3-turbo']);
    // No Cloudflare token goes to the mock.
    expect(mock.calls.every((call) => !call.headers.get('authorization'))).toBe(true);
  });
});

describe('createMockModel', () => {
  it('answers a JSON schema with the JSON it is given', async () => {
    const { ai } = setup({ chat: { json: { subject: 'Hello', priority: 2 } } });
    const { object } = await generateObject({
      model: ai.model(),
      schema: jsonSchema<{ subject: string; priority: number }>({
        type: 'object',
        properties: { subject: { type: 'string' }, priority: { type: 'number' } },
        required: ['subject', 'priority'],
      }),
      prompt: 'Draft it',
    });
    expect(object).toEqual({ subject: 'Hello', priority: 2 });
  });

  it('answers by request, so one stub serves both backends', async () => {
    const { mock, ai } = setup({
      chat: (request) => (request.messages.some((m) => m.text.includes('Dutch')) ? { text: 'Hallo' } : { text: 'Hello' }),
    });
    const dutch = await generateText({ model: ai.model(), prompt: 'Say hello in Dutch' });
    const english = await generateText({ model: ai.model(), system: 'Be brief.', prompt: 'Say hello' });
    expect([dutch.text, english.text]).toEqual(['Hallo', 'Hello']);
    expect(mock.calls).toHaveLength(2);
  });

  it('answers with tool calls', async () => {
    const { ai } = setup({
      chat: (request) =>
        request.tools.includes('create_task')
          ? { toolCalls: [{ name: 'create_task', arguments: { title: 'Call Anna' } }] }
          : { text: 'no tools' },
    });
    const { toolCalls, finishReason } = await generateText({
      model: ai.model(),
      prompt: 'Remind me to call Anna',
      tools: {
        create_task: tool({
          description: 'Create a task',
          inputSchema: jsonSchema<{ title: string }>({
            type: 'object',
            properties: { title: { type: 'string' } },
            required: ['title'],
          }),
        }),
      },
    });
    expect(finishReason).toBe('tool-calls');
    expect(toolCalls.map((call) => [call.toolName, call.input])).toEqual([['create_task', { title: 'Call Anna' }]]);
  });

  it('streams over SSE, OpenAI-compatible and Anthropic alike', async () => {
    const { ai } = setup({ chat: { text: 'streamed answer' } });
    const compat = streamText({ model: ai.model(), prompt: 'hi' });
    expect(await compat.text).toBe('streamed answer');
    expect((await compat.usage).outputTokens).toBe(5);
    const native = streamText({ model: ai.nativeModel('anthropic/claude-haiku-5-5'), prompt: 'hi' });
    expect(await native.text).toBe('streamed answer');
  });

  it("refuses with the API's error, so fallback runs", async () => {
    const { mock, ai } = setup({
      chat: (request) =>
        request.model.startsWith('anthropic/') ? { status: 402, message: 'Your credit balance is too low' } : { text: 'from the fallback' },
    });
    const { text } = await generateText({ model: ai.model('anthropic/claude-sonnet-5-5'), prompt: 'hi' });
    expect(text).toBe('from the fallback');
    expect(mock.calls.map((call) => (call.body as { model: string }).model)).toEqual([
      'anthropic/claude-sonnet-5-5',
      `workers-ai/${DEFAULT_MODEL}`,
    ]);
  });

  it("answers the Rust crate's Mistral and Anthropic calls", async () => {
    const mock = createMockModel({
      chat: { json: { label: 'invoice' } },
      ocr: { pages: ['# Invoice 42', 'Total: 100'], annotation: { total: 100 } },
      transcription: { text: 'Hello there.' },
    });
    const post = (path: string, body: unknown) =>
      mock.fetch(`${MOCK_AI_BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer conformance-mistral-key' },
        body: JSON.stringify(body),
      });
    const read = async <T>(response: Promise<Response>): Promise<T> => (await (await response).json()) as T;

    const chat = await read<{ choices: { message: { content: string } }[] }>(
      post('/chat/completions', {
        model: 'mistral-small-2506',
        messages: [{ role: 'user', content: 'Label it' }],
        response_format: { type: 'json_schema', json_schema: { name: 'label', schema: {} } },
      }),
    );
    expect(JSON.parse(chat.choices[0]?.message.content ?? '')).toEqual({ label: 'invoice' });

    const forced = await read<{ content: unknown[]; stop_reason: string }>(
      post('/v1/messages', {
        model: 'claude-sonnet-5-5',
        max_tokens: 100,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Label it' }] }],
        tools: [{ name: 'label', input_schema: {} }],
        tool_choice: { type: 'tool', name: 'label' },
      }),
    );
    expect(forced.content).toEqual([{ type: 'tool_use', id: 'toolu_mock_1', name: 'label', input: { label: 'invoice' } }]);
    expect(forced.stop_reason).toBe('tool_use');

    const ocr = await read<{ pages: { markdown: string }[]; document_annotation: string }>(
      post('/ocr', { model: 'mistral-ocr-2505', document: { type: 'document_url' } }),
    );
    expect(ocr.pages.map((page) => page.markdown)).toEqual(['# Invoice 42', 'Total: 100']);
    expect(JSON.parse(ocr.document_annotation)).toEqual({ total: 100 });

    const heard = await read<{ text: string }>(post('/audio/transcriptions', { model: 'voxtral-mini-2507' }));
    expect(heard.text).toBe('Hello there.');

    const streamed = await (
      await post('/chat/completions', { model: 'mistral-small-2506', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    ).text();
    expect(streamed).toContain('"object":"chat.completion.chunk"');
    expect(streamed.trimEnd().endsWith('data: [DONE]')).toBe(true);

    const models = await read<{ data: { id: string }[] }>(mock.fetch(`${MOCK_AI_BASE_URL}/models`));
    expect(models.data[0]?.id).toBe('mock-model');
    expect(mock.calls[0]?.headers.get('authorization')).toBe('Bearer conformance-mistral-key');
  });

  it('passes other URLs to the fallback, or fails like a network error', async () => {
    const other = vi.fn(async () => new Response('elsewhere'));
    const mock = createMockModel({}, other as unknown as typeof fetch);
    expect(await (await mock.fetch('https://api.example.com/x')).text()).toBe('elsewhere');
    expect(mock.handles(`https://${MOCK_AI_HOST}/anything`)).toBe(true);
    expect(mock.handles('https://api.mistral.ai/v1/chat/completions')).toBe(false);
    await expect(createMockModel().fetch('https://api.example.com/x')).rejects.toThrow(/fetch failed/);
    mock.reset();
    expect(mock.calls).toHaveLength(0);
  });
});
