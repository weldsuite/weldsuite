/**
 * Core types for the centralized helpdesk workflow engine.
 *
 * The engine is channel-agnostic: it produces StepOutputs that channel
 * adapters render into widget SSE events, Discord embeds, Slack Block Kit, etc.
 */

import type { HelpdeskWorkflowStep as WorkflowStepDef, HelpdeskTriggerConfig as TriggerConfig } from '@weldsuite/db/schema/helpdesk-workflow-types';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { Database } from './db';

export type { WorkflowStepDef };

// ============================================================================
// Channel
// ============================================================================

export type Channel = 'web' | 'discord' | 'slack' | 'email' | 'api' | 'mobile';

// ============================================================================
// Env (Cloudflare bindings)
// ============================================================================

export interface Env {
  // Durable Objects
  ASSIGNMENT_ROUTER: DurableObjectNamespace;

  // CF Workflows
  CONVERSATION_WORKFLOW: Workflow;

  // Database
  HYPERDRIVE_MASTER: Hyperdrive;
  DATABASE_URL_MASTER?: string;
  NEON_API_KEY?: string;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;

  // KV
  WORKSPACE_CACHE: KVNamespace;
  DEDUP_KV: KVNamespace;

  // Queues
  ENTITY_EVENTS: Queue<EntityEventMessage>;

  // Storage
  STORAGE: R2Bucket;
  R2_PUBLIC_URL?: string;

  // Real-time event system
  REALTIME?: Fetcher;

  // Secrets
  DISCORD_BOT_TOKEN?: string;
  SLACK_BOT_TOKEN?: string;
  FIREBASE_SERVICE_ACCOUNT?: string;

  // AI
  CF_ACCOUNT_ID?: string;
  CF_AIG_TOKEN?: string;

  ENVIRONMENT: string;
}

// ============================================================================
// Entity Events (shared wire-format from `@weldsuite/entity-events`)
// ============================================================================

export type {
  EntityAction,
  EntityEventMessage,
  EventSource,
} from '@weldsuite/entity-events/types';

// ============================================================================
// Step Output (channel-agnostic — what the engine produces)
// ============================================================================

export type StepOutput =
  | { type: 'message'; content: string; authorName: string; messageId: string; metadata?: Record<string, unknown> }
  | { type: 'choices'; content: string; options: Array<{ id: string; label: string; value: string }>; authorName: string; messageId: string; stepId: string }
  | { type: 'collect_input'; content: string; fields: Array<{ id: string; label: string; type: string; required?: boolean; placeholder?: string }>; authorName: string; messageId: string; stepId: string }
  | { type: 'ai_typing' }
  | { type: 'ai_token'; token: string; messageId: string }
  | { type: 'ai_complete'; content: string; messageId: string; authorName: string }
  | { type: 'delay'; durationMs: number }
  | { type: 'articles'; articles: Array<{ id: string; title: string; slug: string }> }
  | { type: 'csat'; surveyId: string; content: string; messageId: string; stepId: string }
  | { type: 'system'; action: string; data: Record<string, unknown> };

// ============================================================================
// Customer Input (what comes back from any channel)
// ============================================================================

export interface CustomerInput {
  stepId: string;
  type: 'choice_selected' | 'form_submitted' | 'csat_submitted' | 'message';
  selectedValue?: string;
  selectedLabel?: string;
  submittedData?: Record<string, string>;
  rating?: number;
  feedback?: string;
  content?: string;
}

// ============================================================================
// Inbound Event (from queue or HTTP)
// ============================================================================

export interface InboundEvent {
  type:
    | 'conversation_created'
    | 'message_received'
    | 'customer_response'
    | 'status_changed'
    | 'assigned'
    | 'sla_breach'
    | 'timeout';
  conversationId: string;
  workspaceId: string;
  data: Record<string, unknown>;
}

export interface EventResult {
  action: string;
  data?: unknown;
}

// ============================================================================
// Durable Object State
// ============================================================================

export interface ConversationDOState {
  conversationId: string;
  workspaceId: string;
  channel: Channel;
  channelMetadata: Record<string, unknown>;

  // Workflow execution
  status: 'idle' | 'executing' | 'waiting_for_input' | 'ai_active';
  execution: WorkflowExecution | null;
  pendingWorkflows: QueuedWorkflow[];

  // Zendesk: triggers already fired in current cascade pass
  currentPassFiredIds: string[];

  // SLA (Zendesk breach-timestamp approach)
  sla: SLAState | null;

  // WeldAgent mode
  // 'workflow_step' = AI active from a workflow's ai_auto_reply step
  // 'follow_up' = AI auto-activated after workflows complete (Intercom pattern)
  agentMode?: 'workflow_step' | 'follow_up' | null;

  // Cached WeldAgent config (avoid querying DB on every message)
  cachedAgentConfig?: {
    isActive: boolean;
    onEscalation?: string;
    onResolution?: string;
    onFailure?: string;
    escalationWorkflowId?: string;
    systemInstructions?: string;
    name?: string;
  } | null;

  // Notification state
  agentsNotified: boolean;
}

export interface WorkflowExecution {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: number;
  steps: WorkflowStepDef[];
  currentStepIndex: number;
  stepResults: Record<string, unknown>;
  variables: Record<string, unknown>;
  waitingStepId?: string;
  aiStepId?: string;
  startedAt: number;
  // Mastra workflow run tracking
  mastraRunId?: string;
  suspendedStepId?: string;
}

export interface QueuedWorkflow {
  workflowId: string;
  workflowName: string;
  workflowVersion: number;
  steps: WorkflowStepDef[];
  triggerData: Record<string, unknown>;
  sortOrder: number;
}

export interface SLAState {
  slaId: string;
  responseBreachAt: number | null;
  resolutionBreachAt: number | null;
  responseTargetMinutes: number | null;
  resolutionTargetMinutes: number | null;
  responseWarnings: number[];
  resolutionWarnings: number[];
  responseWarningsSent: number[];
  resolutionWarningsSent: number[];
  paused: boolean;
  pausedAt: number | null;
  businessHours: Record<string, unknown> | null;
}

// ============================================================================
// Workflow State Snapshot (published via @weldsuite/realtime for agent platform)
// ============================================================================

export interface WorkflowStateSnapshot {
  executionId: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: number;
  conversationId: string;
  channel: Channel;
  status: 'idle' | 'executing' | 'waiting_for_input' | 'ai_active';

  currentStepIndex: number;
  totalSteps: number;
  currentStep: {
    id: string;
    name: string;
    type: string;
  } | null;

  steps: Array<{
    id: string;
    name: string;
    type: string;
    status: 'completed' | 'running' | 'waiting_for_input' | 'failed' | 'skipped' | 'pending';
    collectedData: Record<string, unknown> | null;
  }>;

  startedAt: number;
  elapsedMs: number;
  event: string;
}

// ============================================================================
// Notification
// ============================================================================

export type NotifyReason =
  | { type: 'new_conversation'; botHandling?: boolean }
  | { type: 'new_message'; preview: string }
  | { type: 'escalation'; from: 'ai' | 'customer' }
  | { type: 'workflow_waiting'; stepType: string }
  | { type: 'sla_warning'; metric: string; pct: number }
  | { type: 'sla_breach'; metric: string }
  | { type: 'conversation_idle'; idleMinutes: number };

// ============================================================================
// Step Handler (same interface as widget-api — handlers are portable)
// ============================================================================

export interface StepHandler {
  type: string;
  execute(ctx: StepContext): Promise<StepResult>;
}

export interface StepContext {
  inputs: Record<string, unknown>;
  state: ExecutionState;
  options: ExecutorOptions;
  emit: (event: SSEEvent) => void;
  publish: (msg: RealtimePublishMessage) => Promise<void>;
  stepDef: WorkflowStepDef;
}

export interface ExecutionState {
  executionId: string;
  workflowId: string;
  conversationId: string;
  stepResults: Record<string, unknown>;
  variables: Record<string, unknown>;
  triggerData: Record<string, unknown>;
}

export interface ExecutorOptions {
  db: Database;
  env: Env;
  conversationId: string;
  workspaceId: string;
  customerId?: string;
  customerName?: string;
  customerEmail?: string;
}

export interface StepResult {
  success: boolean;
  __waitingForInput?: boolean;
  messageId?: string;
  conversationId?: string;
  content?: string;
  aiContent?: string;
  authorId?: string;
  authorName?: string;
  aiGenerated?: boolean;
  skipped?: boolean;
  error?: string;
  escalated?: boolean;
  output?: StepOutput;
  [key: string]: unknown;
}

export interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface RealtimePublishMessage {
  id: string;
  conversationId: string;
  content: string;
  senderId: string;
  senderName: string;
  senderType: 'agent' | 'system' | 'customer';
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Assignment
// ============================================================================

export interface AssignRequest {
  conversationId: string;
  workspaceId: string;
  departmentId: string;
  mode: 'round_robin' | 'least_busy';
  skills?: string[];
}

export interface AgentCapacity {
  agentId: string;
  userId: string;
  name: string;
  maxActive: number;
  currentActive: number;
  isOnline: boolean;
  isAvailable: boolean;
}
