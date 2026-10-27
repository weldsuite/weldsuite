/**
 * WeldAgent push/in-app helpers. Email is excluded — run-complete and chat-reply
 * events are timely; an inbox copy arrives too late to be useful.
 */

import { createAndDeliverNotification } from '../orchestrator';
import type { Database, NotificationEnv } from '../types';
import { notificationPreview as preview } from './preview';

interface WeldAgentReplyParams<Env extends NotificationEnv> {
  db: Database;
  env: Env;
  workspaceId: string;
  userId: string;
  conversationId: string;
  agentName?: string | null;
  previewText: string;
}

export function weldagentChatActionUrl(conversationId: string): string {
  return `/weldagent/chat/${conversationId}`;
}

export function weldagentRunActionUrl(agentId: string, runId: string): string {
  return `/weldagent/agent/${agentId}/run/${runId}`;
}

export function weldagentAgentActionUrl(agentId: string): string {
  return `/weldagent/agent/${agentId}`;
}

interface WeldAgentApprovalParams<Env extends NotificationEnv> {
  db: Database;
  env: Env;
  workspaceId: string;
  /** The agent's owner: approvals reach them like a manager's sign-off. */
  userId: string;
  agentId: string;
  agentName: string;
  approvalId: string;
  /** What the action would do, in words ("Create task "Follow up""). */
  label: string;
}

/**
 * An agent is waiting for someone to approve an action: its owner, or the
 * person who asked for it in a room, where they would not see it in a chat.
 */
export async function sendWeldAgentApprovalNotification<Env extends NotificationEnv>(
  params: WeldAgentApprovalParams<Env>,
): Promise<string | null> {
  const { db, env, workspaceId, userId, agentId, agentName, approvalId, label } = params;
  return createAndDeliverNotification({
    db,
    env,
    workspaceId,
    userId,
    title: `${agentName} needs your approval: ${label}`,
    body: 'Tap to approve or reject.',
    category: 'weldagent',
    notificationType: 'weldagent_approval',
    entityType: 'weldagent_agent',
    entityId: agentId,
    actionUrl: weldagentAgentActionUrl(agentId),
    severity: 'warning',
    actorType: 'system',
    excludeChannels: ['email'],
    data: { agentId, approvalId },
  });
}

export async function sendWeldAgentReplyNotification<Env extends NotificationEnv>(
  params: WeldAgentReplyParams<Env>,
): Promise<string | null> {
  const { db, env, workspaceId, userId, conversationId, agentName, previewText } = params;
  const title = agentName ? `${agentName} replied` : 'WeldAgent replied';
  return createAndDeliverNotification({
    db,
    env,
    workspaceId,
    userId,
    title,
    body: preview(previewText) || 'Tap to open the conversation',
    category: 'weldagent',
    notificationType: 'weldagent_reply',
    entityType: 'weldagent_conversation',
    entityId: conversationId,
    actionUrl: weldagentChatActionUrl(conversationId),
    severity: 'info',
    actorType: 'system',
    excludeChannels: ['email'],
    data: { conversationId },
  });
}

interface WeldAgentRunParams<Env extends NotificationEnv> {
  db: Database;
  env: Env;
  workspaceId: string;
  userId: string;
  agentId: string;
  runId: string;
  agentName: string;
  success: boolean;
  summary?: string | null;
  error?: string | null;
}

export async function sendWeldAgentRunNotification<Env extends NotificationEnv>(
  params: WeldAgentRunParams<Env>,
): Promise<string | null> {
  const { db, env, workspaceId, userId, agentId, runId, agentName, success, summary, error } = params;
  return createAndDeliverNotification({
    db,
    env,
    workspaceId,
    userId,
    title: success ? `${agentName} finished a run` : `${agentName} run failed`,
    body: success
      ? preview(summary ?? '') || 'Tap to view the result'
      : preview(error ?? '') || 'The agent hit an error',
    category: 'weldagent',
    notificationType: success ? 'agent_run_completed' : 'agent_run_failed',
    entityType: 'weldagent_agent',
    entityId: agentId,
    actionUrl: weldagentRunActionUrl(agentId, runId),
    severity: success ? 'success' : 'error',
    actorType: 'system',
    excludeChannels: ['email'],
    data: { agentId, runId },
  });
}
