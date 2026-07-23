import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Declarative tool definition for the MCP server.
 *
 * Tools do NOT contain a DB handler. Each describes how to call the external
 * API (`apps/workers/external-api`): an HTTP method + path template. A generic executor
 * (`lib/proxy.ts`) forwards the request — and the caller's API key — so the
 * external API runs the canonical auth/validation/business-logic/entity-event
 * path. This keeps the MCP surface in lock-step with the REST API it mirrors.
 */
export interface ToolDefinition {
  /** Tool name exposed over MCP (snake_case). */
  name: string;
  /** Scope required to use the tool; mirrors external-api `requireScope`. */
  scope: string;
  /** Human/LLM-facing description. */
  description: string;
  /** Zod raw shape for the tool inputs (path params + query/body fields). */
  inputSchema: z.ZodRawShape;
  /** HTTP method used against external-api. */
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path template, e.g. `/v1/leads` or `/v1/leads/:id` or `/v1/tickets/:id/messages`. */
  path: string;
  /**
   * Maps each `:placeholder` in `path` to the input field that fills it.
   * e.g. `{ id: 'leadId' }` fills `/v1/leads/:id` from the `leadId` input.
   * Consumed inputs are removed from the query string / JSON body.
   */
  pathParams?: Record<string, string>;
}

/**
 * Helper to create a successful tool result
 */
export function toolResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Helper to create an error tool result
 */
export function toolError(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

// Domain tool manifests — one declarative array per object group, mirroring the
// external API (`apps/workers/external-api`) resource routes one-to-one.
import { crmTools } from './crm';
import { helpdeskTools } from './helpdesk';
import { knowledgeTools } from './knowledge';
import { projectsTools } from './projects';
import { weldflowTools } from './weldflow';
import { chatTools } from './chat';
import { workspaceTools } from './workspace';
import { commerceTools } from './commerce';
import { socialTools } from './social';

/**
 * All registered tools
 */
export const allTools: ToolDefinition[] = [
  ...crmTools,
  ...helpdeskTools,
  ...knowledgeTools,
  ...projectsTools,
  ...weldflowTools,
  ...chatTools,
  ...workspaceTools,
  ...commerceTools,
  ...socialTools,
];
