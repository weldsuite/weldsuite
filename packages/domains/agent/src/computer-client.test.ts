/**
 * Unit tests for agent computer client helpers (no live runtime).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { computerExec, computerStatus, isAgentComputerConfigured } from './computer-client';
import type { WeldAgentEnv as Env } from './env';

describe('isAgentComputerConfigured', () => {
  it('requires URL + secret and enabled flag', () => {
    expect(
      isAgentComputerConfigured({
        AGENT_RUNTIME_URL: 'http://localhost:8795',
        INTERNAL_API_SECRET: 's',
        AGENT_COMPUTER_ENABLED: 'true',
      } as Env),
    ).toBe(true);

    expect(
      isAgentComputerConfigured({
        AGENT_RUNTIME_URL: 'http://localhost:8795',
        INTERNAL_API_SECRET: 's',
        AGENT_COMPUTER_ENABLED: 'false',
      } as Env),
    ).toBe(false);

    expect(
      isAgentComputerConfigured({
        AGENT_RUNTIME_URL: '',
        INTERNAL_API_SECRET: 's',
      } as Env),
    ).toBe(false);
  });
});

describe('runtime transport', () => {
  const ok = () => new Response('{"ok":true}', { status: 200 });
  const input = { workspaceId: 'ws_1', command: 'ls' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is configured by the binding alone (no URL, no secret)', () => {
    expect(isAgentComputerConfigured({ AGENT_RUNTIME: {} as Fetcher } as Env)).toBe(true);
    expect(
      isAgentComputerConfigured({ AGENT_RUNTIME: {} as Fetcher, AGENT_COMPUTER_ENABLED: 'false' } as Env),
    ).toBe(false);
  });

  it('prefers the AgentRuntimeInternal binding and sends no Authorization header', async () => {
    const fetchSpy = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchSpy);
    const binding = vi.fn(async (_url: string, _init?: RequestInit) => ok());

    await computerExec(
      {
        AGENT_RUNTIME: { fetch: binding } as unknown as Fetcher,
        AGENT_RUNTIME_URL: 'https://rt.test',
        INTERNAL_API_SECRET: 's',
      } as Env,
      input,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    const [url, init] = binding.mock.calls[0];
    expect(url).toBe('https://agent-runtime/v1/computer/exec');
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });

  it('falls back to the public URL with the bearer when the binding is absent', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => ok());
    vi.stubGlobal('fetch', fetchSpy);

    await computerExec({ AGENT_RUNTIME_URL: 'https://rt.test/', INTERNAL_API_SECRET: 's' } as Env, input);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://rt.test/v1/computer/exec');
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

    await computerExec(
      env(async () => {
        throw new Error('Worker has no entrypoint named "AgentRuntimeInternal"');
      }),
      input,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await expect(
      computerExec(
        env(async () => {
          throw new Error('network lost');
        }),
        input,
      ),
    ).rejects.toThrow('network lost');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('reports the computer as not configured when neither transport is set', async () => {
    expect(await computerStatus({} as Env, 'ws_1')).toEqual({ enabled: false, reason: 'not_configured' });
  });
});
