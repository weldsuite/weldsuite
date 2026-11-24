/**
 * The workspace step of connecting an AI app (an MCP client) on the
 * Kubernetes editions (WeldID): `/api/mcp/workspace-selections/{challenge}`.
 * WeldID knows people, not workspaces, so after its consent screen it sends
 * the browser to the platform's `/auth/mcp-workspace` page, which asks which
 * workspace the connection is for. The answer goes into the connection's
 * access tokens, and the MCP server checks it against the person's
 * memberships on every request. Served by the Rust backend only; on Global,
 * Clerk's consent screen picks the organization. Zod v3.
 */

import { z } from 'zod';

/** `GET /api/mcp/workspace-selections/{challenge}`. */
export const mcpWorkspaceSelectionSchema = z.object({
  /** The app asking, as the consent screen named it, and where it lives. */
  client: z.object({
    name: z.string(),
    host: z.string(),
  }),
  /** The person's active workspaces (at most 50). */
  workspaces: z.array(
    z.object({
      /** `workspaces.id`: what the choice sends back. */
      id: z.string(),
      name: z.string(),
      slug: z.string(),
    }),
  ),
  /**
   * The workspace to go on with unasked: the one the app's MCP address
   * names (`/mcp/w/<workspace>`), else the person's only one.
   */
  suggestedWorkspaceId: z.string().nullable(),
});

export type McpWorkspaceSelection = z.infer<typeof mcpWorkspaceSelectionSchema>;

/** `POST /api/mcp/workspace-selections/{challenge}`: a workspace, or no. */
export const decideMcpWorkspaceSelectionInput = z.union([
  z.object({ workspaceId: z.string().min(1) }).strict(),
  z.object({ decision: z.literal('deny') }).strict(),
]);

export type DecideMcpWorkspaceSelectionInput = z.infer<typeof decideMcpWorkspaceSelectionInput>;

/** Where the browser goes on: back to the sign-in, which returns to the app. */
export const mcpWorkspaceSelectionDecidedSchema = z.object({
  redirectTo: z.string().url(),
});

export type McpWorkspaceSelectionDecided = z.infer<typeof mcpWorkspaceSelectionDecidedSchema>;
