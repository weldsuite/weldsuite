/**
 * A mock model server for tests, as a `fetch` stub. It answers what
 * `@weldsuite/ai` sends with `AI_TEST_BASE_URL` set (config.ts) and what the
 * Rust server's `weldsuite-ai` crate sends in a conformance build
 * (`rust/bins/weldsuite/src/ai.rs`, Mistral at the same base URL):
 *
 * - OpenAI-compatible `POST …/chat/completions` (Mistral, OpenAI, vLLM, and
 *   Workers AI through the gateway's compat endpoint): text, a JSON answer
 *   for a `json_schema` response format, tool calls, and SSE with
 *   `stream: true`;
 * - Anthropic's `POST …/messages`, streaming too; a forced tool call
 *   (`tool_choice: { type: 'tool' }`) carries a JSON answer;
 * - `POST …/embeddings`, Mistral's `POST …/ocr` and
 *   `POST …/audio/transcriptions` (Voxtral);
 * - Workers AI's `POST …/run` (Jev) and `POST …/run/<model>` (Whisper);
 * - `GET …/models` (a key check).
 *
 * A conformance test gives the worker `mock.env` and stubs `fetch` with
 * `mock.fetch`. The stub answers by URL, so it serves both runs (the Rust
 * server's calls come back through the outbound bridge), and the harness
 * leaves calls to {@link MOCK_AI_HOST} out of the compared outbound calls:
 * the two backends call different models in their own request shapes.
 * Compare what the routes answer and write instead.
 *
 * ```ts
 * const mock = createMockModel({ chat: { json: { subject: 'Hello' } } });
 * vi.stubGlobal('fetch', mock.fetch);
 * const res = await app.request('/api/mail-ai/draft', init, { ...env, ...mock.env });
 * expect(mock.calls.map((c) => c.path)).toContain('/chat/completions');
 * ```
 *
 * Tests only: never imported by runtime code.
 */

import { withoutTrailingSlashes } from '../config.js';

/** The base URL tests point both backends at (`AI_TEST_BASE_URL`). */
export const MOCK_AI_BASE_URL = 'https://mock-ai.weldsuite.test/v1';

/** Its host: calls to it are the mock model's, whatever the path. */
export const MOCK_AI_HOST = 'mock-ai.weldsuite.test';

/** A tool call the model answers with. */
export interface MockToolCall {
  id?: string;
  name: string;
  arguments: unknown;
}

/** What a chat call answers. */
export type MockChatReply =
  | { text: string }
  /** JSON text (OpenAI-compatible), or a forced tool call's input (Anthropic). */
  | { json: unknown }
  | { toolCalls: MockToolCall[]; text?: string }
  /** A refusal or error: this status, with the API's error body. */
  | { status: number; message?: string };

/** A chat call as either API sent it, for a reply function. */
export interface MockChatRequest {
  api: 'openai' | 'anthropic';
  model: string;
  /** The system prompt. */
  system: string;
  /** Every other message's text, in order. */
  messages: { role: string; text: string }[];
  /** A JSON answer was asked for (`response_format`, or a forced tool). */
  wantsJson: boolean;
  /** The tools offered, by name. */
  tools: string[];
  stream: boolean;
  body: Record<string, unknown>;
}

export interface MockModelOptions {
  /** Default {@link MOCK_AI_BASE_URL}. */
  baseUrl?: string;
  /**
   * The chat answer, or a function of the request (answer by prompt, never
   * by call order: the stub serves both backends' runs). Default: `{}` when
   * JSON is asked for, else the text `ok`.
   */
  chat?: MockChatReply | ((request: MockChatRequest) => MockChatReply);
  /** Mistral OCR: one markdown string per page, and the document annotation. */
  ocr?: { pages: string[]; annotation?: unknown };
  /** Speech to text (Voxtral, Whisper). */
  transcription?: { text: string; language?: string; segments?: { start: number; end: number; text: string }[] };
  /** Jev's answers, by question id. */
  jev?: Record<string, unknown>;
  /** Embedding size; default 1024 (the search index's). */
  embeddingDimensions?: number;
  /** Tokens every chat call reports; default 10 in, 5 out. */
  usage?: { input: number; output: number };
}

/** One request the mock answered. */
export interface MockModelCall {
  method: string;
  url: string;
  /** The path after the base URL (`/chat/completions`, `/v1/messages`, …). */
  path: string;
  body: unknown;
  headers: Headers;
}

export interface MockModel {
  readonly baseUrl: string;
  /** The worker env that points `@weldsuite/ai` (and Rust) at the mock. */
  readonly env: { AI_TEST_BASE_URL: string };
  /** Every request answered, in order. */
  readonly calls: MockModelCall[];
  /** A `fetch` that answers the mock's URLs and passes others to `fallback`. */
  readonly fetch: typeof fetch;
  /** Whether `url` is the mock's. */
  handles(url: string): boolean;
  /** Answer one of the mock's requests. */
  respond(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  reset(): void;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function bodyOf(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  let text: string | null = null;
  const body = init?.body;
  if (body === undefined || body === null) {
    if (input instanceof Request) text = (await input.clone().text()) || null;
  } else if (typeof body === 'string') text = body;
  else if (body instanceof Uint8Array) text = new TextDecoder().decode(body);
  else if (body instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(body));
  else if (body instanceof URLSearchParams) text = body.toString();
  else return '<form-data>';
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function sse(events: { event?: string; data: unknown }[]): Response {
  const text = events
    .map(({ event, data }) => {
      const name = event ? 'event: ' + event + '\n' : '';
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      return `${name}data: ${payload}\n\n`;
    })
    .join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A message's text, from a string or content parts. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n');
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function chatRequest(api: 'openai' | 'anthropic', body: Record<string, unknown>): MockChatRequest {
  const rawMessages = Array.isArray(body.messages) ? body.messages.map(record) : [];
  const tools = (Array.isArray(body.tools) ? body.tools.map(record) : [])
    .map((tool) => (api === 'openai' ? record(tool.function).name : tool.name))
    .filter((name): name is string => typeof name === 'string');
  if (api === 'openai') {
    const format = record(body.response_format).type;
    return {
      api,
      model: String(body.model ?? ''),
      system: rawMessages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n'),
      messages: rawMessages.filter((m) => m.role !== 'system').map((m) => ({ role: String(m.role), text: textOf(m.content) })),
      wantsJson: format === 'json_schema' || format === 'json_object',
      tools,
      stream: body.stream === true,
      body,
    };
  }
  return {
    api,
    model: String(body.model ?? ''),
    system: textOf(body.system),
    messages: rawMessages.map((m) => ({ role: String(m.role), text: textOf(m.content) })),
    wantsJson: record(body.tool_choice).type === 'tool',
    tools,
    stream: body.stream === true,
    body,
  };
}

/** A deterministic vector for `text`, so repeated runs embed alike. */
function vector(text: string, dimensions: number): number[] {
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) % 1_000_003;
  return Array.from({ length: dimensions }, (_, i) => Math.round(Math.sin(seed + i) * 1e6) / 1e6);
}

/** A chat reply's text content: its JSON as text, its text, or none. */
function replyContent(reply: MockChatReply): string | null {
  if ('json' in reply) return JSON.stringify(reply.json);
  if ('text' in reply) return reply.text ?? null;
  return null;
}

export function createMockModel(options: MockModelOptions = {}, fallback?: typeof fetch): MockModel {
  const baseUrl = withoutTrailingSlashes(options.baseUrl ?? MOCK_AI_BASE_URL);
  const usage = options.usage ?? { input: 10, output: 5 };
  const calls: MockModelCall[] = [];

  const handles = (url: string): boolean => {
    if (url.startsWith(`${baseUrl}/`) || url === baseUrl) return true;
    try {
      return new URL(url).hostname === MOCK_AI_HOST;
    } catch {
      return false;
    }
  };

  const replyTo = (request: MockChatRequest): MockChatReply => {
    const chat = options.chat;
    if (typeof chat === 'function') return chat(request);
    if (chat) return chat;
    return request.wantsJson ? { json: {} } : { text: 'ok' };
  };

  const openAiChat = (body: Record<string, unknown>): Response => {
    const request = chatRequest('openai', body);
    const reply = replyTo(request);
    if ('status' in reply) {
      return json({ error: { message: reply.message ?? 'mock refusal', type: 'mock_error', code: reply.status } }, reply.status);
    }
    const toolCalls =
      'toolCalls' in reply
        ? reply.toolCalls.map((call, index) => ({
            id: call.id ?? `call_${index + 1}`,
            type: 'function' as const,
            function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
          }))
        : undefined;
    const content = replyContent(reply);
    const finish = toolCalls ? 'tool_calls' : 'stop';
    const tokens = {
      prompt_tokens: usage.input,
      completion_tokens: usage.output,
      total_tokens: usage.input + usage.output,
    };
    const head = { id: 'chatcmpl-mock', created: 0, model: request.model };
    if (!request.stream) {
      return json({
        ...head,
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }],
        usage: tokens,
      });
    }
    const chunk = (
      delta: Record<string, unknown>,
      finishReason: string | null,
      extra: Record<string, unknown> = {},
    ): { data: unknown } => ({
      data: { ...head, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra },
    });
    const events = [chunk({ role: 'assistant', content: content ?? '' }, null)];
    if (toolCalls) {
      events.push(chunk({ tool_calls: toolCalls.map((call, index) => ({ index, ...call })) }, null));
    }
    events.push(chunk({}, finish, { usage: tokens }), { data: '[DONE]' });
    return sse(events);
  };

  const anthropicMessages = (body: Record<string, unknown>): Response => {
    const request = chatRequest('anthropic', body);
    const reply = replyTo(request);
    if ('status' in reply) {
      return json({ type: 'error', error: { type: 'api_error', message: reply.message ?? 'mock refusal' } }, reply.status);
    }
    const forced = record(body.tool_choice);
    const blocks: Record<string, unknown>[] = [];
    if ('json' in reply) {
      if (forced.type === 'tool' && typeof forced.name === 'string') {
        blocks.push({ type: 'tool_use', id: 'toolu_mock_1', name: forced.name, input: reply.json });
      } else {
        blocks.push({ type: 'text', text: JSON.stringify(reply.json) });
      }
    } else if ('toolCalls' in reply) {
      if (reply.text) blocks.push({ type: 'text', text: reply.text });
      reply.toolCalls.forEach((call, index) =>
        blocks.push({ type: 'tool_use', id: call.id ?? `toolu_mock_${index + 1}`, name: call.name, input: call.arguments ?? {} }),
      );
    } else {
      blocks.push({ type: 'text', text: reply.text });
    }
    const stopReason = blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
    const message = { id: 'msg_mock', type: 'message', role: 'assistant', model: request.model };
    if (!request.stream) {
      return json({
        ...message,
        content: blocks,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: usage.input, output_tokens: usage.output },
      });
    }
    const events: { event: string; data: unknown }[] = [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 0 } },
        },
      },
    ];
    blocks.forEach((block, index) => {
      const isTool = block.type === 'tool_use';
      events.push(
        {
          event: 'content_block_start',
          data: { type: 'content_block_start', index, content_block: isTool ? { ...block, input: {} } : { type: 'text', text: '' } },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index,
            delta: isTool ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text },
          },
        },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index } },
      );
    });
    events.push(
      {
        event: 'message_delta',
        data: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output } },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    );
    return sse(events);
  };

  const embeddings = (body: Record<string, unknown>): Response => {
    const inputs = Array.isArray(body.input) ? body.input.map(String) : [String(body.input ?? '')];
    const dimensions = options.embeddingDimensions ?? 1024;
    return json({
      object: 'list',
      model: String(body.model ?? ''),
      data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: vector(text, dimensions) })),
      usage: { prompt_tokens: inputs.length * usage.input, total_tokens: inputs.length * usage.input },
    });
  };

  const ocr = (body: Record<string, unknown>): Response => {
    const pages = options.ocr?.pages ?? ['# Mock document'];
    return json({
      model: String(body.model ?? ''),
      pages: pages.map((markdown, index) => ({ index, markdown, images: [], dimensions: { dpi: 200, height: 2200, width: 1700 } })),
      document_annotation: options.ocr?.annotation === undefined ? null : JSON.stringify(options.ocr.annotation),
      usage_info: { pages_processed: pages.length, doc_size_bytes: 1024 },
    });
  };

  const transcription = (body: unknown): Response => {
    const text = options.transcription?.text ?? 'Mock transcript.';
    const segments = options.transcription?.segments ?? [{ start: 0, end: 1, text }];
    return json({
      model: String(record(body).model ?? 'voxtral-mini-latest'),
      text,
      language: options.transcription?.language ?? 'en',
      segments,
      usage: { prompt_audio_seconds: Math.ceil(segments.at(-1)?.end ?? 1), prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
    });
  };

  const whisper = (): Response => {
    const text = options.transcription?.text ?? 'Mock transcript.';
    const segments = options.transcription?.segments ?? [{ start: 0, end: 1, text }];
    return json({
      success: true,
      result: {
        text,
        word_count: text.split(/\s+/).filter(Boolean).length,
        segments,
        transcription_info: { language: options.transcription?.language ?? 'en', duration: segments.at(-1)?.end ?? 1 },
      },
    });
  };

  const jev = (): Response =>
    json({
      success: true,
      result: { model: 'typesafe/jev', answers: options.jev ?? {}, usage: { input_tokens: usage.input, output_tokens: usage.output } },
    });

  const respond = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const body = await bodyOf(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const pathname = new URL(url).pathname;
    const basePath = withoutTrailingSlashes(new URL(baseUrl).pathname);
    const path = url.startsWith(baseUrl) && pathname.startsWith(basePath) ? pathname.slice(basePath.length) || '/' : pathname;
    calls.push({ method, url, path, body, headers });

    if (method === 'GET' && pathname.endsWith('/models')) {
      return json({ object: 'list', data: [{ id: 'mock-model', object: 'model', type: 'model' }] });
    }
    if (method !== 'POST') return json({ error: { message: `mock model: no ${method} ${path}` } }, 404);
    if (pathname.endsWith('/chat/completions')) return openAiChat(record(body));
    if (pathname.endsWith('/messages')) return anthropicMessages(record(body));
    if (pathname.endsWith('/embeddings')) return embeddings(record(body));
    if (pathname.endsWith('/ocr')) return ocr(record(body));
    if (pathname.endsWith('/audio/transcriptions')) return transcription(body);
    if (/\/run\/.+/.test(pathname)) return whisper();
    if (pathname.endsWith('/run')) return jev();
    return json({ error: { message: `mock model: no POST ${path}` } }, 404);
  };

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (handles(url)) return respond(input, init);
    if (fallback) return fallback(input, init);
    throw new TypeError(`fetch failed: the mock model does not answer ${url}`);
  }) as typeof fetch;

  return {
    baseUrl,
    env: { AI_TEST_BASE_URL: baseUrl },
    calls,
    fetch: mockFetch,
    handles,
    respond,
    reset: () => {
      calls.length = 0;
    },
  };
}
