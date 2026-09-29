/**
 * The bindings the WeldAgent runtime reads (tenant DB resolution, the
 * @weldsuite/ai gateway, notifications, entity events, the D1 routine index,
 * the durable job workflow and the agent-runtime computer). Any worker Env
 * with them fits: agent-api runs the runtime, chat-api dispatches room
 * replies through it, and app-api hosts the draining weldagent-job instances.
 */

import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { NotificationEnv } from '@weldsuite/notifications/types';
import type { DbEnv } from '@weldsuite/worker-kit/env';
import type { WeldAgentJob } from './jobs';

export interface WeldAgentEnv extends DbEnv, NotificationEnv {
  /** Entity-events hub queue (records agents create publish like any mutation). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /**
   * D1 schedule index (shared with workflow-worker). Routine writes keep it in
   * sync so the hourly routine sweep only opens due workspaces.
   */
  SCHEDULE_INDEX?: D1Database;
  /** CF Workflow that runs WeldAgent background work (chat replies, routine
   *  and WeldChat room runs) beyond the ~30s `waitUntil` budget. Hosted in
   *  agent-api (class in ./workflows/weldagent-job). When it is not bound the
   *  job runs inline (see ./jobs). */
  WELDAGENT_JOB?: Workflow<WeldAgentJob>;

  // --- AI (@weldsuite/ai) — Cloudflare AI Gateway ---------------------------
  // See packages/core/ai/src/config.ts for the full list of recognised keys.
  CF_ACCOUNT_ID?: string;
  /** Optional; must be `cloudflare` (the only gateway). */
  AI_GATEWAY_PROVIDER?: string;
  /** Default canonical model id; falls back to the free Workers AI default. */
  AI_DEFAULT_MODEL?: string;
  /** Cloudflare API token (Workers AI + AI Gateway Run) → `Authorization`. */
  AI_GATEWAY_API_TOKEN?: string;
  /** AI Gateway id (`cf-aig-gateway-id`). Omit to use the account default. */
  CF_AI_GATEWAY?: string;
  /** Gateway auth token (`cf-aig-authorization`), for "Authenticated" gateways. */
  CF_AIG_TOKEN?: string;
  /** The @weldsuite/ai token fallback when AI_GATEWAY_API_TOKEN is unset. */
  CLOUDFLARE_API_TOKEN?: string;
  /** Accepted by @weldsuite/ai as an alias of CF_ACCOUNT_ID. */
  CLOUDFLARE_ACCOUNT_ID?: string;

  // --- WeldAgent cloud computer (agent-runtime worker) ----------------------
  /**
   * Base URL for weldsuite-agent-runtime (Cloudflare Sandbox + Browser Run).
   * Example: http://localhost:8795 or https://agent-runtime-test.weldsuite.org
   */
  AGENT_RUNTIME_URL?: string;
  /** When "false", computer/browser tools refuse calls. Default enabled if URL set. */
  AGENT_COMPUTER_ENABLED?: string;
  /** Shared secret the agent-runtime worker checks on computer/browser calls. */
  INTERNAL_API_SECRET?: string;
}
