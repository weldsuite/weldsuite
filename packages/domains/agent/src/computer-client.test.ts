/**
 * Unit tests for the agent-runtime client transport (no live runtime).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentComputerUnavailableError, browserClose } from './computer-client';
import type { WeldAgentEnv as Env } from './env';

describe('runtime transport', () => {
  const ok = () => new Response('{"ok":true}', { status: 200 });
  const input = { workspaceId: 'ws_1', agentId: 'agt_1' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefers the AgentRuntimeInternal binding and sends no Authorization header', async () => {
    const fetchSpy = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchSpy);
    const binding = vi.fn(async (_url: string, _init?: RequestInit) => ok());

    await browserClose(
      {
        AGENT_RUNTIME: { fetch: binding } as unknown as Fetcher,
        AGENT_RUNTIME_URL: 'https://rt.test',
        INTERNAL_API_SECRET: 's',
      } as Env,
      input,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    const [url, init] = binding.mock.calls[0];
    expect(url).toBe('https://agent-runtime/v1/browser/close');
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });

  it('falls back to the public URL with the bearer when the binding is absent', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => ok());
    vi.stubGlobal('fetch', fetchSpy);

    await browserClose({ AGENT_RUNTIME_URL: 'https://rt.test/', INTERNAL_API_SECRET: 's' } as Env, input);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://rt.test/v1/browser/close');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer s');
  });

  it('falls back when the entrypoint is not deployed yet, but not on other failures', async () => {
    const fetchSpy = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchSpy);
    const env = (binding: () => Promise<Response>) =>
      ({
        AGENT_RUNTIME: { fetch: binding } as unknown as Fetcher,
        AGENT_RUNTIME_URL: 'https://rt.test',
        INTERNAL_API_SECRET: 's',
      }) as Env;

    await browserClose(
      env(async () => {
        throw new Error('Worker has no entrypoint named "AgentRuntimeInternal"');
      }),
      input,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await expect(
      browserClose(
        env(async () => {
          throw new Error('network lost');
        }),
        input,
      ),
    ).rejects.toThrow('network lost');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses when neither transport is set', async () => {
    await expect(browserClose({} as Env, input)).rejects.toBeInstanceOf(AgentComputerUnavailableError);
  });
});
