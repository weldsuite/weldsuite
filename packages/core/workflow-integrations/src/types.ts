/**
 * Integration catalog contracts.
 *
 * These are *metadata-only* definitions — the single source of truth describing
 * which third-party providers WeldConnect can connect to, what they can trigger
 * on, and what actions they expose. The runtime behaviour (OAuth exchange,
 * action HTTP calls, inbound webhook parsing) lives in the workers/app-api,
 * keyed by the same string ids — exactly as `ACTION_TYPES` (metadata) is kept
 * separate from `actionHandlers` (behaviour) in the workflow engine.
 *
 * Everything here must stay JSON-serialisable so the catalog can be shipped to
 * the builder UI over the wire without a transform.
 */

export type IntegrationCategory =
  | 'communication'
  | 'productivity'
  | 'crm'
  | 'commerce'
  | 'ai'
  | 'developer'
  | 'custom';

/** OAuth2 authorization-code flow config. Client credentials are resolved from
 *  worker env at runtime (never embedded here). */
export interface OAuthConfig {
  kind: 'oauth2';
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Env var name holding the OAuth client id (resolved in app-api). */
  clientIdEnv: string;
  /** Env var name holding the OAuth client secret (resolved in app-api). */
  clientSecretEnv: string;
  /** Static params appended to the authorize URL (e.g. `access_type=offline`). */
  authorizeParams?: Record<string, string>;
  /** Provider field on the token response that carries a bot/team token to
   *  stash in `settings` (Slack returns the bot token outside `access_token`). */
  storeOnSettings?: string[];
}

export interface ApiKeyField {
  key: string;
  label: string;
  /** Mask in the UI + encrypt at rest. */
  secret?: boolean;
  placeholder?: string;
}

export interface ApiKeyConfig {
  kind: 'api_key';
  fields: ApiKeyField[];
}

export type AuthConfig = OAuthConfig | ApiKeyConfig;

/** How an inbound trigger is delivered. `webhook` arrives at
 *  integration-webhook-worker; `poll` is driven by a Trigger.dev schedule. */
export type TriggerKind = 'webhook' | 'poll';

export interface TriggerDef {
  /** Namespaced event id, e.g. `slack.message`. Stored on the workflow's
   *  `integration_event` trigger as `event`. */
  id: string;
  name: string;
  description: string;
  kind: TriggerKind;
  /** Fields exposed to downstream steps (for the builder's variable picker). */
  outputFields?: string[];
}

export type ActionInputType = 'string' | 'text' | 'number' | 'boolean' | 'json';

export interface ActionInputField {
  key: string;
  label: string;
  type: ActionInputType;
  required?: boolean;
  placeholder?: string;
  description?: string;
}

export interface ActionDef {
  /** Namespaced action id, e.g. `slack.post_message`. Matches the handler key
   *  registered in the workflow engine's `actionHandlers` map. */
  id: string;
  name: string;
  description: string;
  inputs: ActionInputField[];
}

export interface IntegrationDef {
  /** Provider id — also the value stored in `workflow_integrations.type`. */
  id: string;
  /** The `IntegrationType` enum value in the db schema (usually === id). */
  type: string;
  label: string;
  description: string;
  category: IntegrationCategory;
  /** Lucide icon name used by the builder + integrations marketplace. */
  icon: string;
  auth: AuthConfig;
  actions: ActionDef[];
  triggers: TriggerDef[];
}
