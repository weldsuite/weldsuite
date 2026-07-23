/**
 * Step handler types adapted for the widget API's Env.
 */

import type { HelpdeskWorkflowStep as WorkflowStepDef } from '@weldsuite/db/schema/helpdesk-workflow-types';
import type { Database } from '../db';
import type { Env } from '../index';

export type { WorkflowStepDef };

export interface StepHandler {
  type: string;
  execute(ctx: StepContext): Promise<StepResult>;
}

export interface StepContext {
  inputs: Record<string, unknown>;
  state: ExecutionState;
  options: ExecutorOptions;
  emit: (event: { event: string; data: Record<string, unknown> }) => void;
  publish: (msg: PublishMessage) => Promise<void>;
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
}

export interface StepResult {
  success: boolean;
  __waitingForInput?: boolean;
  messageId?: string;
  conversationId?: string;
  content?: string;
  skipped?: boolean;
  error?: string;
  escalated?: boolean;
  [key: string]: unknown;
}

export interface PublishMessage {
  id: string;
  conversationId: string;
  content: string;
  senderId: string;
  senderName: string;
  senderType: 'agent' | 'system' | 'customer';
  timestamp: string;
  metadata?: Record<string, unknown>;
}
