/**
 * Unit tests for agent computer client helpers (no live runtime).
 */

import { describe, expect, it } from 'vitest';
import { isAgentComputerConfigured } from './computer-client';
import type { Env } from '../../types';

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
