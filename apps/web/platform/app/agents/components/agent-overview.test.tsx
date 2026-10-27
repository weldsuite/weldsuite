import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { WorkspaceAgent } from '@weldsuite/app-api-client/schemas/workspace-agents';

const state = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: state.push }) }));

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns] };
});

vi.mock('./agent-avatar', () => ({ AgentAvatar: () => <span data-testid="avatar" /> }));
vi.mock('@/components/icons/weldagent-icon', () => ({ WeldAgentIcon: () => <span /> }));

import { AgentOverview } from './agent-overview';

function agent(id: string, patch: Partial<WorkspaceAgent> = {}): WorkspaceAgent {
  return {
    id,
    name: `Agent ${id}`,
    description: null,
    icon: null,
    status: 'active',
    systemPrompt: 'Triage tickets',
    modelId: 'claude-opus-5-5',
    temperature: '0.7',
    maxTokens: 4096,
    permissions: [],
    enabledTools: [],
    eventSubscriptions: [],
    maxIterations: 10,
    maxTotalTokens: 50000,
    createdBy: 'user_me',
    ownerId: 'user_me',
    visibility: 'private',
    subagentIds: [],
    delegateToSelf: false,
    totalRuns: 0,
    successfulRuns: 0,
    failedRuns: 0,
    lastRunAt: null,
    lastRunStatus: null,
    createdAt: '2026-10-20T10:00:00Z',
    updatedAt: '2026-10-20T10:00:00Z',
    ...patch,
  };
}

const baseProps = { loading: false, creating: false, canCreate: true, onCreate: vi.fn() };

beforeEach(() => {
  state.push.mockReset();
  baseProps.onCreate.mockReset();
});

describe('AgentOverview', () => {
  it('lists each agent with its status and description', () => {
    render(
      <AgentOverview
        {...baseProps}
        agents={[
          agent('a', { name: 'Support triage', description: 'Sorts new helpdesk tickets' }),
          agent('b', { name: 'Digest', status: 'paused' }),
          agent('c', { name: 'Untitled agent', status: 'draft', systemPrompt: '' }),
        ]}
      />,
    );
    expect(screen.getByText('Support triage')).toBeTruthy();
    expect(screen.getByText('Sorts new helpdesk tickets')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Paused')).toBeTruthy();
    // An agent that still needs its setup interview says so, in both places.
    expect(screen.getAllByText('Setting up…').length).toBeGreaterThan(0);
  });

  it('opens an agent and offers a new one', () => {
    render(<AgentOverview {...baseProps} agents={[agent('a', { name: 'Support triage' })]} />);
    fireEvent.click(screen.getByText('Support triage'));
    expect(state.push).toHaveBeenCalledWith('/agents/a');
    fireEvent.click(screen.getByRole('button', { name: /new agent/i }));
    expect(baseProps.onCreate).toHaveBeenCalledTimes(1);
  });

  it('hides the create button from people who may not create agents', () => {
    render(<AgentOverview {...baseProps} canCreate={false} agents={[agent('a')]} />);
    expect(screen.queryByRole('button', { name: /new agent/i })).toBeNull();
  });

  it('shows the empty state when there are no agents', () => {
    render(<AgentOverview {...baseProps} agents={[]} />);
    expect(screen.getByText('No AI agents yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: /create your first agent/i })).toBeTruthy();
  });

  it('shows a loading state, not the empty state, while agents load', () => {
    render(<AgentOverview {...baseProps} loading agents={[]} />);
    expect(screen.queryByText('No AI agents yet')).toBeNull();
  });
});
