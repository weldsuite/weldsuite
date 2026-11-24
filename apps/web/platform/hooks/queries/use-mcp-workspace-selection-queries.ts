/**
 * The workspace step of connecting an AI app (an MCP client) on the
 * Kubernetes editions: `/auth/mcp-workspace` reads the app and the person's
 * workspaces, then records the choice. Org-less: the person may not have a
 * workspace open in this tab.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { isApiError } from '@weldsuite/api-client';
import type { DecideMcpWorkspaceSelectionInput } from '@weldsuite/app-api-client/schemas/mcp-workspace-selections';
import { useAppApi } from '@/lib/api/use-app-api';

export const mcpWorkspaceSelectionKeys = {
  all: ['mcp-workspace-selection'] as const,
  detail: (challenge: string) => [...mcpWorkspaceSelectionKeys.all, challenge] as const,
};

/** True when the sign-in link can't be used any more (unknown, expired or used). */
export function isExpiredSelection(error: unknown): boolean {
  return isApiError(error) && error.status === 404;
}

/** The app asking and the person's workspaces. Never refetched: the link is single use. */
export function useMcpWorkspaceSelection(challenge: string, enabled = true) {
  const { mcpWorkspaceSelections } = useAppApi();
  return useQuery({
    queryKey: mcpWorkspaceSelectionKeys.detail(challenge),
    queryFn: () => mcpWorkspaceSelections.get(challenge),
    select: (res) => res.data,
    enabled: enabled && challenge.length > 0,
    retry: (failureCount, error) => !isExpiredSelection(error) && failureCount < 2,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/** Record the choice; the answer says where the browser goes on. */
export function useDecideMcpWorkspaceSelection(challenge: string) {
  const { mcpWorkspaceSelections } = useAppApi();
  return useMutation({
    mutationFn: (input: DecideMcpWorkspaceSelectionInput) => mcpWorkspaceSelections.decide(challenge, input),
  });
}
