import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

type Lookup = { data?: { agentId: string | null } | null; isSuccess: boolean; isError: boolean };

const state = vi.hoisted(() => ({
  replace: vi.fn(),
  conversation: null as string | null,
  lookup: { data: undefined, isSuccess: false, isError: false } as Lookup,
}));

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ replace: state.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(state.conversation ? { conversation: state.conversation } : {}),
}));
vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns] };
});
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('@weldsuite/permissions/react', () => ({ useCanAny: () => true }));
vi.mock('@/hooks/queries/use-agent-queries', () => ({ useAgents: () => ({ data: [], isLoading: false }) }));
vi.mock('@/hooks/queries/use-weldagent-queries', () => ({ useWeldAgentConversation: () => state.lookup }));
vi.mock('./hooks/use-create-agent', () => ({ useCreateAndOpenAgent: () => ({ create: vi.fn(), isPending: false }) }));
vi.mock('./components/agent-overview', () => ({
  AgentOverview: ({ loading }: { loading: boolean }) => <div data-testid="overview" data-loading={String(loading)} />,
}));

import AgentsPage from './page';

describe('AgentsPage notification links', () => {
  beforeEach(() => {
    state.replace.mockReset();
    state.conversation = 'conv_1';
  });

  it('stays on the loading state while the linked conversation is looked up', () => {
    state.lookup = { data: undefined, isSuccess: false, isError: false };
    render(<AgentsPage />);
    expect(screen.getByTestId('overview').dataset.loading).toBe('true');
    expect(state.replace).not.toHaveBeenCalled();
  });

  it('opens the agent the conversation belongs to', () => {
    state.lookup = { data: { agentId: 'agt_1' }, isSuccess: true, isError: false };
    render(<AgentsPage />);
    expect(state.replace).toHaveBeenCalledWith('/agents/agt_1');
  });

  it('falls back to the overview when the lookup fails instead of loading forever', () => {
    state.lookup = { data: undefined, isSuccess: false, isError: true };
    render(<AgentsPage />);
    expect(screen.getByTestId('overview').dataset.loading).toBe('false');
    expect(state.replace).toHaveBeenCalledWith('/agents');
  });
});
