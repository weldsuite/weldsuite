import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpSession } from './api-types';
import type { Env } from '../types/env';
import { canUseScope } from './permissions';
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
 * Create an MCP server instance for one authenticated session.
 * A new instance is created per request (stateless).
 *
 * Tool calls are dispatched in-process into this worker's own v1 API
 * (`src/api/`) — see {@link executeTool}.
 *
 * After the static (house) tools, agent tools declared by user-created
 * WeldApps are registered dynamically. Loading failures are isolated: static
 * tools always register regardless of the dynamic loader's outcome.
 */
export async function createMcpServer(
  session: McpSession,
  env: Env,
  executionCtx: ExecutionContext,
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

  // Only offer tools the user's role could actually use. The binding gate is
  // still `requireScope` inside the API, so a listed tool can still be refused.
  const registeredNames = new Set<string>();
  for (const tool of allTools) {
    if (!canUseScope(session.permissions, tool.scope)) continue;
    registeredNames.add(tool.name);

    server.tool(tool.name, tool.description, tool.inputSchema, async (args) => {
      try {
        return await executeTool(tool, args as Record<string, unknown>, session, env, executionCtx);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'An unexpected error occurred';
        console.error(`[MCP Tool] ${tool.name} error:`, error);
        return toolError(message);
      }
    });
  }

  // Register user-created WeldApp agent tools (dynamic, scope-gated).
  // `loadUserAppTools` swallows failures and returns [] so a broken app can
  // never take the static tools down with it.
  if (canUseScope(session.permissions, USER_APPS_SCOPE)) {
    const userAppTools = await loadUserAppTools(session, env, executionCtx);

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
              env,
              executionCtx,
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
      workspaceName: session.workspaceName,
      tier: session.tier,
      userId: session.userId,
      role: session.role,
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
