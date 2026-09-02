import { describe, expect, it } from 'vitest';
import { resolveAgentModelId } from './executor';
import type { Env } from '../../types';

describe('resolveAgentModelId', () => {
  it('keeps Workers AI ids without a gateway', () => {
    expect(
      resolveAgentModelId({} as Env, '@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
    ).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  });

  it('falls back third-party models when CF_AI_GATEWAY is unset', () => {
    expect(resolveAgentModelId({} as Env, 'anthropic/claude-sonnet-4-5')).toBe(
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    );
  });

  it('keeps third-party models when a gateway is configured', () => {
    expect(
      resolveAgentModelId(
        { CF_AI_GATEWAY: 'weldsuite' } as Env,
        'anthropic/claude-sonnet-4-5',
      ),
    ).toBe('anthropic/claude-sonnet-4-5');
  });
});
