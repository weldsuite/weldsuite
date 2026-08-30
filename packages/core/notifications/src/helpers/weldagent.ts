/**
 * WeldAgent push/in-app helpers. Email is excluded — run-complete and chat-reply
 * events are timely; an inbox copy arrives too late to be useful.
 */

import { createAndDeliverNotification } from '../orchestrator';
import type { Database, NotificationEnv } from '../types';

function preview(text: string, max = 180): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

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
