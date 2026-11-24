/**
 * App-API client for the workspace step of connecting an AI app:
 * `/api/mcp/workspace-selections/{challenge}` (Rust backend, membership mode
 * on WeldID). Signed in, no workspace needed.
 */

import type { ClientApi, DataResponse } from '../types';
import {
  decideMcpWorkspaceSelectionInput,
  mcpWorkspaceSelectionDecidedSchema,
  mcpWorkspaceSelectionSchema,
  type DecideMcpWorkspaceSelectionInput,
  type McpWorkspaceSelection,
  type McpWorkspaceSelectionDecided,
} from '../schemas/mcp-workspace-selections';

function path(challenge: string): string {
  return `/mcp/workspace-selections/${encodeURIComponent(challenge)}`;
}

export function createMcpWorkspaceSelectionsApi(api: ClientApi) {
  return {
    /** The app asking and the person's workspaces. A 404 when the link can't be used. */
    async get(challenge: string): Promise<DataResponse<McpWorkspaceSelection>> {
      const res = await api.get<DataResponse<McpWorkspaceSelection>>(path(challenge));
      return { ...res, data: mcpWorkspaceSelectionSchema.parse(res.data) };
    },

    /** Record the choice (or the refusal); answers where the browser goes on. */
    async decide(
      challenge: string,
      input: DecideMcpWorkspaceSelectionInput,
    ): Promise<DataResponse<McpWorkspaceSelectionDecided>> {
      const body = decideMcpWorkspaceSelectionInput.parse(input);
      const res = await api.post<DataResponse<McpWorkspaceSelectionDecided>>(path(challenge), body);
      return { ...res, data: mcpWorkspaceSelectionDecidedSchema.parse(res.data) };
    },
  };
}

export type McpWorkspaceSelectionsApi = ReturnType<typeof createMcpWorkspaceSelectionsApi>;
