import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiKeySession } from './api-types';
import { hasScope } from './scope-check';
import { executeTool } from './proxy';
import { allTools, toolError } from '../tools/registry';
import {
  loadUserAppTools,
  userAppInputShape,
  executeUserAppTool,
} from '../tools/user-apps';

/** Scope gating user-created WeldApp agent tools (and app storage access). */
const USER_APPS_SCOPE = 'user-apps:manage';

/**
 * Create an MCP server instance with tools filtered by the API key's scopes.
 * A new instance is created per request (stateless).
 *
 * Tool calls are proxied to the External API over the `externalApi` service
 * binding, forwarding the caller's API key. `baseUrl` is used only to build the
 * request URL's path/query (see {@link executeTool}).
 *
 * After the static (house) tools, agent tools declared by user-created
 * WeldApps are registered dynamically — only when the key holds the
 * `user-apps:manage` scope. Loading failures are isolated: static tools always
 * register regardless of the dynamic loader's outcome.
 */
export async function createMcpServer(
  session: ApiKeySession,
  baseUrl: string,
  externalApi: Fetcher,
): Promise<McpServer> {
  const server = new McpServer(
    {
      name: 'WeldSuite',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  // Register tools filtered by the API key's scopes
  const registeredNames = new Set<string>();
  for (const tool of allTools) {
    if (!hasScope(session, tool.scope)) continue;
    registeredNames.add(tool.name);

    server.tool(tool.name, tool.description, tool.inputSchema, async (args) => {
      try {
        return await executeTool(tool, args as Record<string, unknown>, session, baseUrl, externalApi);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'An unexpected error occurred';
        console.error(`[MCP Tool] ${tool.name} error:`, error);
        return toolError(message);
      }
    });
  }

  // Register user-created WeldApp agent tools (dynamic, scope-gated).
  // `loadUserAppTools` swallows fetch failures and returns [] so a broken
  // external-api endpoint can never take the static tools down with it.
  if (hasScope(session, USER_APPS_SCOPE)) {
    const userAppTools = await loadUserAppTools(session.apiKey, baseUrl, externalApi);

    for (const appTool of userAppTools) {
      // `${appCode}_${name}`, deduped by numeric suffix on collision (with
      // static tools or other app tools sharing the same code + name).
      const baseName = `${appTool.appCode}_${appTool.name}`;
      let toolName = baseName;
      for (let i = 2; registeredNames.has(toolName); i++) {
        toolName = `${baseName}_${i}`;
      }
      registeredNames.add(toolName);

      server.tool(
        toolName,
        `[${appTool.appName}] ${appTool.description}`,
        userAppInputShape(appTool.parameters),
        async (args) => {
          try {
            return await executeUserAppTool(
              appTool,
              args as Record<string, unknown>,
              session,
              baseUrl,
              externalApi,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : 'An unexpected error occurred';
            console.error(`[MCP Tool] ${toolName} error:`, error);
            return toolError(message);
          }
        },
      );
    }
  }

  // Register workspace info resource
  server.resource('workspace-info', 'weldsuite://workspace/info', { description: 'Workspace name, plan tier, and configuration' }, async () => {
    const info = {
      workspaceId: session.workspaceId,
      tier: session.tier,
      keyType: session.keyType,
    };

    return {
      contents: [
        {
          uri: 'weldsuite://workspace/info',
          mimeType: 'application/json',
          text: JSON.stringify(info, null, 2),
        },
      ],
    };
  });

  return server;
}
