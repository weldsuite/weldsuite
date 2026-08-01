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
import {
  loadCustomObjectTools,
  buildCustomObjectTools,
  executeCustomObjectTool,
} from '../tools/custom-objects';

/** Scope gating user-created WeldApp agent tools (and app storage access). */
const USER_APPS_SCOPE = 'user-apps:manage';

/** Scope gating WeldObjects (user-defined custom object) agent tools. */
const CUSTOM_OBJECTS_SCOPE = 'custom-objects:read';

/**
 * Guidance sent to the client on `initialize`.
 *
 * Tool results carry record identifiers because follow-up calls need them, but
 * reading them aloud makes the assistant sound like a database console. This
 * asks for the identifiers to be used silently. It pairs with the response
 * shaping in `lib/present.ts` — instructions alone are advisory, so the payload
 * is also arranged to make the natural phrasing the easy one.
 */
const SERVER_INSTRUCTIONS = `You are working inside a WeldSuite workspace — a business platform covering CRM,
projects, helpdesk, commerce, accounting, chat and more.

How to talk about records:

- Refer to things by their name, title or subject, never by their identifier.
  Say "the Acme Industries lead", not "lead 01HX3…".
- Record identifiers appear in HTML comments marked as internal. Use them when
  calling other tools, but do not repeat them to the user and do not present
  them as something the user needs to remember or supply.
- If the user needs to act on a specific record, describe it well enough to be
  unambiguous — name plus a distinguishing detail such as company, status or
  date — rather than offering an identifier.
- Only reveal an identifier if the user explicitly asks for it, or if they are
  clearly working with the API themselves.

How to answer:

- Summarise. A list tool returns one line per record; report what matters for
  the question rather than reciting every field.
- Use the record's own vocabulary. Statuses, stages and types come from the
  user's configuration, so quote them as-is instead of translating them.
- When a search returns nothing, say so plainly and suggest a broader search
  rather than speculating about what might exist.
- When more results are available, say so and offer to continue instead of
  silently truncating.

Making changes:

- Confirm before creating, updating or deleting anything the user has not
  explicitly asked for.
- After a change, describe what changed in business terms — "marked the Acme
  quote as accepted" — not by echoing the returned payload.
- Tools are limited to the permissions of the signed-in user. A refusal means
  their role lacks that permission, not that the record is missing; say so
  rather than retrying.`;

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
      instructions: SERVER_INSTRUCTIONS,
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

  // Register WeldObjects tools (dynamic, scope-gated). Same failure posture as
  // the WeldApp tools above: `loadCustomObjectTools` returns [] on any error so
  // a misconfigured object can never take the static tools down with it.
  if (canUseScope(session.permissions, CUSTOM_OBJECTS_SCOPE)) {
    const objects = await loadCustomObjectTools(session, env, executionCtx);

    for (const object of objects) {
      for (const objectTool of buildCustomObjectTools(object)) {
        // A user-defined slug can collide with a static tool ("list_products"
        // if someone names an object `products`) or with another object's
        // tools. Dedupe by numeric suffix rather than dropping the tool, so the
        // object stays reachable either way.
        let toolName = objectTool.name;
        for (let i = 2; registeredNames.has(toolName); i++) {
          toolName = `${objectTool.name}_${i}`;
        }
        registeredNames.add(toolName);

        server.tool(
          toolName,
          objectTool.description,
          objectTool.inputSchema,
          async (args) => {
            try {
              return await executeCustomObjectTool(
                objectTool,
                args as Record<string, unknown>,
                session,
                env,
                executionCtx,
              );
            } catch (error) {
              const message =
                error instanceof Error ? error.message : 'An unexpected error occurred';
              console.error(`[MCP Tool] ${toolName} error:`, error);
              return toolError(message);
            }
          },
        );
      }
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
