import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const client = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApiClient: () => ({ getClient: async () => client }) }));

import { readOAuthFlow } from '@/lib/integrations-oauth-flow';
import { useConnectWorkflowProvider, useConnectWorkflowProviderApiKey } from './use-workflow-integration-queries';

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

afterEach(() => {
  client.post.mockReset();
  sessionStorage.clear();
});

describe('workflow connection hooks', () => {
  it('connects an API-key provider with its credentials', async () => {
    client.post.mockResolvedValue({ data: { id: 'int_1', status: 'connected', provider: 'airtable' } });
    const { result } = renderHook(() => useConnectWorkflowProviderApiKey(), { wrapper });
    act(() => result.current.mutate({ provider: 'airtable', credentials: { token: 'pat1' } }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.post).toHaveBeenCalledWith('/workflow-integrations/airtable/apikey', { credentials: { token: 'pat1' } });
  });

  it('records the OAuth flow before it leaves for the provider', async () => {
    client.post.mockResolvedValue({ data: { authorizeUrl: '#provider', state: 's1' } });
    const { result } = renderHook(() => useConnectWorkflowProvider(), { wrapper });
    act(() => result.current.mutate({ provider: 'gmail', returnTo: '/settings/integrations/gmail' }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.post).toHaveBeenCalledWith('/workflow-integrations/gmail/authorize', {});
    expect(readOAuthFlow()).toEqual({ kind: 'workflow', provider: 'gmail', returnTo: '/settings/integrations/gmail' });
  });
});
