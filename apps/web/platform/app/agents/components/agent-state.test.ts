import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_WORKSPACE_AGENT_MODEL } from '@weldsuite/app-api-client/schemas/workspace-agents';

const edition = vi.hoisted(() => ({ hasAiSettings: vi.fn(() => false) }));
vi.mock('@/lib/edition', () => edition);

import { resolveModelId } from './agent-state';

describe('resolveModelId', () => {
  beforeEach(() => edition.hasAiSettings.mockReset());

  it('keeps a Claude id and replaces a legacy id with the default on Global', () => {
    edition.hasAiSettings.mockReturnValue(false);
    expect(resolveModelId(DEFAULT_WORKSPACE_AGENT_MODEL)).toBe(DEFAULT_WORKSPACE_AGENT_MODEL);
    // Agents created when the column default was Sonnet 4.5 still hold it;
    // agent-api only accepts the Claude ids, so the form must not save it back.
    expect(resolveModelId('anthropic/claude-sonnet-4-5')).toBe(DEFAULT_WORKSPACE_AGENT_MODEL);
    expect(resolveModelId('mistral/mistral-large-4-0')).toBe(DEFAULT_WORKSPACE_AGENT_MODEL);
    expect(resolveModelId(null)).toBe(DEFAULT_WORKSPACE_AGENT_MODEL);
  });

  it('keeps any catalog model and the policy default on a Kubernetes install', () => {
    edition.hasAiSettings.mockReturnValue(true);
    expect(resolveModelId('mistral/mistral-large-4-0')).toBe('mistral/mistral-large-4-0');
    expect(resolveModelId('default')).toBe('default');
    expect(resolveModelId(undefined)).toBe(DEFAULT_WORKSPACE_AGENT_MODEL);
  });
});
