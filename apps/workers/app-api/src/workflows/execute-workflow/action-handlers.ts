/**
 * Action handlers for WeldConnect workflow step execution.
 *
 * Ported from apps/api-worker/src/workflows/execute-workflow/action-handlers.ts
 * (W4 legacy-worker phase-out). Adaptations for app-api:
 *  - `Env` comes from `../../types` (app-api's typed bindings)
 *  - send_email posts through app-api's own Cloudflare send binding
 *    (`lib/cloudflare-email`) instead of an HTTP round-trip to api-worker's
 *    /api/internal/send-email endpoint
 *  - ai_generate / ai_classify run through `@weldsuite/ai` + the prepaid
 *    credit wallet (`services/ai/billing`) — api-worker's `services/ai`
 *    facade was gutted in the AI teardown and its dynamic `generate` import
 *    would throw at runtime
 */

import { eq, and, isNull, asc, sql } from 'drizzle-orm';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import { getEntityTable, getEntityIdPrefix } from './entity-tables';
import * as cfEmail from '../../lib/cloudflare-email';
import type { Env } from '../../types';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';

// ============================================================================
// Types
// ============================================================================

export type WorkflowDb = NeonHttpDatabase<typeof schema>;

export interface ActionContext {
  tenant: { workspaceId: string; userId: string };
  executionId: string;
  db: WorkflowDb;
  env: Env;
  previousResults: Record<string, unknown>;
  triggerData: unknown;
  variables: Record<string, unknown>;
  loopItem?: unknown;
  loopIndex?: number;
}

export type ActionHandler = (
  inputs: Record<string, unknown>,
  context: ActionContext,
) => Promise<unknown>;

// ============================================================================
// Waiting-for-input result type
// ============================================================================

export interface WaitingForInputResult {
  __waitingForInput: true;
  conversationId?: string;
  messageId?: string;
  stepType: 'send_choices' | 'collect_input' | 'manual_step';
}

export function isWaitingForInput(result: unknown): result is WaitingForInputResult {
  return typeof result === 'object' && result !== null && '__waitingForInput' in result;
}

// ============================================================================
// Realtime publishing helper (uses RealtimePublisher via env)
// ============================================================================

async function publishRealtime(
  env: Env,
  workspaceId: string,
  channel: string,
  event: string,
  data: unknown,
): Promise<void> {
  if (!env.REALTIME) return;
  try {
    const { RealtimePublisher } = await import('@weldsuite/realtime/server');
    const rt = new RealtimePublisher(env.REALTIME);
    // For conversation events, use conversationPublish
    if (channel.startsWith('conversation:')) {
      const convId = channel.split(':')[1];
      await rt.conversationPublish(convId, { type: event, ...((data && typeof data === 'object') ? data : { data }), ts: Date.now() });
    } else {
      // Workspace-level events
      await rt.publish(workspaceId, channel.replace(`workspace:${workspaceId}`, 'helpdesk'), event, data, 'system');
    }
  } catch (err) {
    console.warn(`[Realtime] Failed to publish ${event}: ${err}`);
  }
}

// ============================================================================
// Action Handlers
// ============================================================================

async function handleSendEmail(
  inputs: Record<string, unknown>,
  ctx: ActionContext,
): Promise<unknown> {
  const to = inputs.to as string | string[] | undefined;
  if (!to || (typeof to === 'string' && !to.trim()) || (Array.isArray(to) && to.length === 0)) {
    throw new Error('No recipients defined for send_email action');
  }

  const toRecipients = typeof to === 'string'
    ? to.split(',').map(e => e.trim()).filter(Boolean)
    : to.filter(Boolean);

  if (toRecipients.length === 0) throw new Error('No valid recipients after parsing');

  // Look up sender account
  const accounts = await ctx.db
    .select()
    .from(schema.mailAccounts)
    .where(and(eq(schema.mailAccounts.status, 'active'), isNull(schema.mailAccounts.deletedAt)))
    .limit(5);

  const fromId = inputs.from as string | undefined;
  const account = fromId
    ? accounts.find((a: any) => a.email === fromId || a.id === fromId)
    : accounts.find((a: any) => a.isDefault) || accounts[0];

  if (!account) {
    throw new Error('No email account configured');
  }

  // Send via app-api's own Cloudflare Email Sending binding (api-worker used
  // an internal HTTP hop to /api/internal/send-email — same provider).
  if (!ctx.env.SEND_EMAIL) {
    throw new Error('SEND_EMAIL binding not configured for email sending');
  }

  const fromAddress = (account as any).displayName
    ? `${(account as any).displayName} <${(account as any).email}>`
    : (account as any).email;

  const result = await cfEmail.sendEmail(ctx.env, {
    from: fromAddress,
    to: toRecipients,
    subject: String(inputs.subject || ''),
    html: String(inputs.body || inputs.html || ''),
    text: String(inputs.body || '').replace(/<[^>]*>/g, ''),
    cc: inputs.cc as string[] | undefined,
    bcc: inputs.bcc as string[] | undefined,
  });

  return { success: true, messageId: result.messageId, from: (account as any).email };
}

async function handleSendNotification(
  inputs: Record<string, unknown>,
  ctx: ActionContext,
): Promise<unknown> {
  const title = String(inputs.title || '');
  const body = String(inputs.body || inputs.message || '');
  if (!title) throw new Error('Notification title is required');

  let userIds: string[] = [];
  if (Array.isArray(inputs.userIds) && inputs.userIds.length > 0) {
    userIds = inputs.userIds.map(id => String(id));
  } else if (inputs.userId) {
    userIds = [String(inputs.userId)];
  } else if (ctx.tenant.userId) {
    userIds = [ctx.tenant.userId];
  }
  if (userIds.length === 0) throw new Error('At least one recipient is required');

  const notificationIds: string[] = [];
  const now = new Date();

  for (const userId of userIds) {
    const notificationId = generateId('notif');
    notificationIds.push(notificationId);
    // NOTE: unlike api-worker's copy, no workspaceId here — the tenant-DB
    // `notifications` table has no workspace_id column (schema drift the
    // never-type-checked api-worker never surfaced).
    await ctx.db.insert(schema.notifications).values({
      id: notificationId,
      userId,
      title,
      body: body || null,
      category: String(inputs.category || 'task'),
      notificationType: String(inputs.notificationType || inputs.type || 'custom'),
      entityType: inputs.entityType ? String(inputs.entityType) : null,
      entityId: inputs.entityId ? String(inputs.entityId) : null,
      actionUrl: inputs.actionUrl ? String(inputs.actionUrl) : null,
      icon: inputs.icon ? String(inputs.icon) : null,
      severity: String(inputs.severity || 'info'),
      data: (inputs.data as Record<string, unknown>) || null,
      isRead: false,
      deliveredInApp: true,
      deliveredEmail: false,
      deliveredPush: false,
      createdAt: now,
    });
  }

  return { sent: true, notificationIds, count: notificationIds.length };
}

async function handleCreateRecord(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const entityType = String(inputs.entity || inputs.entityType || '');
  const data = (inputs.data || inputs.fields || {}) as Record<string, unknown>;
  if (!entityType) throw new Error('Entity type is required');

  const table = getEntityTable(entityType);
  const idPrefix = getEntityIdPrefix(entityType);
  const insertData: Record<string, unknown> = { id: generateId(idPrefix), ...data, createdAt: new Date(), updatedAt: new Date() };
  if ('workspaceId' in table) insertData.workspaceId = ctx.tenant.workspaceId;

  // `table` is dynamically resolved (any), so drizzle's insert typing
  // degrades to a non-iterable union — normalise the returning() shape.
  const created = (await ctx.db.insert(table).values(insertData).returning()) as unknown as Record<string, unknown>[];
  return { created: true, record: created[0] };
}

async function handleUpdateRecord(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const entityType = String(inputs.entity || inputs.entityType || '');
  const recordId = String(inputs.id || inputs.recordId || '');
  const data = (inputs.data || inputs.fields || {}) as Record<string, unknown>;
  if (!entityType) throw new Error('Entity type is required');
  if (!recordId) throw new Error('Record ID is required');

  const table = getEntityTable(entityType);
  const whereConditions = [eq(table.id, recordId)];
  if ('workspaceId' in table) whereConditions.push(eq(table.workspaceId, ctx.tenant.workspaceId));

  const [updated] = await ctx.db.update(table).set({ ...data, updatedAt: new Date() }).where(and(...whereConditions)).returning();
  if (!updated) throw new Error(`Record ${recordId} not found`);
  return { updated: true, record: updated };
}

async function handleDeleteRecord(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const entityType = String(inputs.entity || inputs.entityType || '');
  const recordId = String(inputs.id || inputs.recordId || '');
  const hardDelete = inputs.hardDelete === true;
  if (!entityType) throw new Error('Entity type is required');
  if (!recordId) throw new Error('Record ID is required');

  const table = getEntityTable(entityType);
  const whereConditions = [eq(table.id, recordId)];
  if ('workspaceId' in table) whereConditions.push(eq(table.workspaceId, ctx.tenant.workspaceId));

  if (hardDelete) {
    await ctx.db.delete(table).where(and(...whereConditions));
  } else {
    await ctx.db.update(table).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(...whereConditions));
  }
  return { deleted: true, id: recordId };
}

async function handleQueryData(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const entityType = String(inputs.entity || inputs.entityType || '');
  if (!entityType) throw new Error('Entity type is required');

  const table = getEntityTable(entityType);
  const filters = (inputs.filters || inputs.where || {}) as Record<string, unknown>;
  const limit = Number(inputs.limit) || 100;
  const offset = Number(inputs.offset) || 0;

  const records = await ctx.db.select().from(table).where(isNull(table.deletedAt)).limit(limit).offset(offset);

  let filteredRecords = records;
  for (const [key, value] of Object.entries(filters)) {
    filteredRecords = filteredRecords.filter((record: any) => {
      if (typeof value === 'object' && value !== null) {
        const op = value as { operator?: string; value?: unknown };
        switch (op.operator) {
          case 'eq': case 'equals': return record[key] === op.value;
          case 'neq': case 'not_equals': return record[key] !== op.value;
          case 'contains': return String(record[key]).includes(String(op.value));
          case 'gt': return Number(record[key]) > Number(op.value);
          case 'lt': return Number(record[key]) < Number(op.value);
          default: return record[key] === op.value;
        }
      }
      return record[key] === value;
    });
  }

  return { records: filteredRecords, count: filteredRecords.length };
}

async function handleSetVariable(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const varName = String(inputs.name || inputs.variableName || '');
  if (!varName) throw new Error('Variable name is required');
  ctx.variables[varName] = inputs.value;
  return { set: true, name: varName, value: inputs.value };
}

async function handleLoop(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const items = inputs.items as unknown[];
  const iteratorName = String(inputs.iteratorName || 'item');
  if (!Array.isArray(items)) throw new Error('Items must be an array');

  const results: unknown[] = [];
  for (let i = 0; i < items.length; i++) {
    ctx.variables[iteratorName] = items[i];
    ctx.variables[`${iteratorName}Index`] = i;
    results.push({ index: i, item: items[i], processed: true });
  }
  return { items: results, count: results.length };
}

async function handleWebhook(inputs: Record<string, unknown>, _ctx: ActionContext): Promise<unknown> {
  const url = String(inputs.url || inputs.webhookUrl || '');
  const method = String(inputs.method || 'POST').toUpperCase();
  const headers = (inputs.headers || {}) as Record<string, string>;
  const body = inputs.body || inputs.payload || inputs.data;
  if (!url) throw new Error('Webhook URL is required');

  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const responseText = await response.text();
  let responseData: unknown;
  try { responseData = JSON.parse(responseText); } catch { responseData = responseText; }

  if (!response.ok) throw new Error(`Webhook failed: ${response.status} - ${responseText.slice(0, 200)}`);
  return { success: true, status: response.status, response: responseData };
}

async function handleLog(inputs: Record<string, unknown>): Promise<unknown> {
  const message = String(inputs.message || inputs.text || '');
  const level = String(inputs.level || 'info').toLowerCase();
  switch (level) {
    case 'error': console.error(`[LOG] ${message}`); break;
    case 'warn': case 'warning': console.warn(`[LOG] ${message}`); break;
    default: console.log(`[LOG] ${message}`);
  }
  return { logged: true, message };
}

async function handleDelay(inputs: Record<string, unknown>): Promise<unknown> {
  // Note: actual sleep is handled by the CF Workflow step.sleep() in the main executor.
  // This handler just returns the duration for the caller to use.
  let durationMs = 1000;
  let durationDescription = '1 second';

  if (inputs.days && Number(inputs.days) > 0) {
    durationMs = Number(inputs.days) * 86400000;
    durationDescription = `${inputs.days} day(s)`;
  } else if (inputs.hours && Number(inputs.hours) > 0) {
    durationMs = Number(inputs.hours) * 3600000;
    durationDescription = `${inputs.hours} hour(s)`;
  } else if (inputs.minutes && Number(inputs.minutes) > 0) {
    durationMs = Number(inputs.minutes) * 60000;
    durationDescription = `${inputs.minutes} minute(s)`;
  } else if (inputs.seconds && Number(inputs.seconds) > 0) {
    durationMs = Number(inputs.seconds) * 1000;
    durationDescription = `${inputs.seconds} second(s)`;
  } else if (inputs.duration || inputs.ms) {
    durationMs = Number(inputs.duration || inputs.ms || 1000);
    durationDescription = `${Math.ceil(durationMs / 1000)} second(s)`;
  }

  return { delayed: true, duration: durationDescription, durationMs, __delayMs: durationMs };
}

async function handleHttpRequest(inputs: Record<string, unknown>): Promise<unknown> {
  const url = String(inputs.url);
  const method = String(inputs.method || 'GET').toUpperCase();
  const headers = (inputs.headers as Record<string, string>) || {};
  const body = inputs.body;
  const timeout = Number(inputs.timeout) || 30000;
  if (!url) throw new Error('URL is required');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const responseText = await response.text();
    let parsedData: unknown;
    try { parsedData = JSON.parse(responseText); } catch { parsedData = responseText; }

    return { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()), data: parsedData };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`Request timed out after ${timeout}ms`);
    throw error;
  }
}

async function handleTransform(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const transform = String(inputs.transform || inputs.operation || 'pick');
  const data = inputs.data || ctx.previousResults;

  switch (transform) {
    case 'pick': {
      const fields = inputs.fields as string[];
      if (!fields || !Array.isArray(fields)) throw new Error('Fields array is required for pick');
      const result: Record<string, unknown> = {};
      for (const field of fields) result[field] = (data as Record<string, unknown>)[field];
      return result;
    }
    case 'map': {
      const sourceArray = inputs.source || data;
      if (!Array.isArray(sourceArray)) throw new Error('Source must be an array for map');
      return sourceArray.map((item: any) => item[String(inputs.mapField || 'id')]);
    }
    case 'filter': {
      const sourceArray = inputs.source || data;
      if (!Array.isArray(sourceArray)) throw new Error('Source must be an array for filter');
      return sourceArray.filter((item: any) => item[String(inputs.filterField || '')] === inputs.filterValue);
    }
    case 'merge': {
      const objects = inputs.objects as Record<string, unknown>[];
      if (!Array.isArray(objects)) throw new Error('Objects array is required for merge');
      return Object.assign({}, ...objects);
    }
    case 'stringify': return JSON.stringify(data);
    case 'parse': return typeof data === 'string' ? JSON.parse(data) : data;
    default: return data;
  }
}

async function handleCondition(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const field = inputs.field as string;
  const operator = String(inputs.operator || 'eq');
  const value = inputs.value;

  let fieldValue: unknown;
  if (field && typeof field === 'string') {
    if (field.startsWith('steps.')) {
      const [, stepId, ...rest] = field.split('.');
      const stepOutput = ctx.previousResults[stepId] as Record<string, unknown>;
      fieldValue = rest.reduce((obj: any, prop) => obj?.[prop], stepOutput);
    } else if (field.startsWith('trigger.')) {
      const props = field.slice(8).split('.');
      fieldValue = props.reduce((obj: any, prop) => obj?.[prop], ctx.triggerData);
    } else if (field.startsWith('variables.')) {
      fieldValue = ctx.variables[field.slice(10)];
    } else if (field.startsWith('loop.')) {
      const prop = field.slice(5);
      fieldValue = prop === 'item' ? ctx.loopItem : prop === 'index' ? ctx.loopIndex : undefined;
    } else {
      fieldValue = inputs[field];
    }
  }

  let passed = false;
  switch (operator) {
    case 'eq': case 'equals': passed = fieldValue === value; break;
    case 'neq': case 'not_equals': passed = fieldValue !== value; break;
    case 'gt': case 'greater_than': passed = Number(fieldValue) > Number(value); break;
    case 'gte': case 'greater_than_or_equals': passed = Number(fieldValue) >= Number(value); break;
    case 'lt': case 'less_than': passed = Number(fieldValue) < Number(value); break;
    case 'lte': case 'less_than_or_equals': passed = Number(fieldValue) <= Number(value); break;
    case 'contains': passed = String(fieldValue).includes(String(value)); break;
    case 'starts_with': passed = String(fieldValue).startsWith(String(value)); break;
    case 'ends_with': passed = String(fieldValue).endsWith(String(value)); break;
    case 'exists': passed = fieldValue !== undefined && fieldValue !== null; break;
    case 'not_exists': passed = fieldValue === undefined || fieldValue === null; break;
    case 'in': passed = Array.isArray(value) && value.includes(fieldValue); break;
    case 'not_in': passed = !Array.isArray(value) || !value.includes(fieldValue); break;
    case 'matches': passed = new RegExp(String(value)).test(String(fieldValue)); break;
    default: passed = true;
  }
  return { passed, result: fieldValue };
}

async function handleSendSms(inputs: Record<string, unknown>): Promise<unknown> {
  const to = String(inputs.to || inputs.phoneNumber || '');
  const body = String(inputs.body || inputs.message || '');
  if (!to) throw new Error('Phone number is required');
  if (!body) throw new Error('Message body is required');
  // TODO: Integrate with Telnyx SMS API via env.TELNYX_API_KEY
  return { sent: true, message: 'SMS queued (Telnyx integration pending)', status: 'pending' };
}

// ============================================================================
// AI Handlers — @weldsuite/ai (Cloudflare AI Gateway) + prepaid credit wallet.
// api-worker delegated to its `services/ai` facade, which the AI teardown
// emptied; this is the app-api rebuild of the same contract.
// ============================================================================

async function callAiGateway(
  env: Env,
  messages: Array<{ role: string; content: string }>,
  opts: { modelId?: string; temperature?: number; maxTokens?: number; workspaceId: string; userId: string },
): Promise<{ content: string; modelId: string; usage: unknown; creditsUsed?: number }> {
  const { createWeldAI, generateText, isGatewayConfigured, recommended } = await import('@weldsuite/ai');
  const { resolveAiMetering, assertAiCredits, chargeAiUsage } = await import('../../services/ai/billing');

  if (!isGatewayConfigured(env)) {
    throw new Error('AI gateway is not configured');
  }

  const modelId = opts.modelId || recommended.draft.free;
  const metering = await resolveAiMetering(env, opts.workspaceId, opts.userId);
  await assertAiCredits(metering); // hard gate: throws when the wallet is empty

  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') || undefined;
  const prompt = messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');

  const ai = createWeldAI(env);
  const result = await generateText({
    model: ai.model(modelId),
    system,
    prompt,
    temperature: opts.temperature,
    maxOutputTokens: opts.maxTokens,
    maxRetries: 1,
  });

  const creditsUsed = await chargeAiUsage(metering, {
    modelId,
    usage: result.usage,
    op: 'workflow',
  });

  return { content: result.text, modelId, usage: result.usage, creditsUsed };
}

async function handleAiGenerate(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const prompt = String(inputs.prompt || '');
  if (!prompt) throw new Error('Prompt is required');

  const model = inputs.model ? String(inputs.model) : undefined;
  const modelId = model && !model.includes('/') ? `openai/${model}` : model;
  const messages: Array<{ role: string; content: string }> = [];
  if (inputs.systemPrompt) messages.push({ role: 'system', content: String(inputs.systemPrompt) });
  messages.push({ role: 'user', content: prompt });

  const result = await callAiGateway(ctx.env, messages, {
    modelId,
    temperature: inputs.temperature !== undefined ? Number(inputs.temperature) : 0.7,
    maxTokens: Number(inputs.maxTokens || inputs.max_tokens) || 1024,
    workspaceId: ctx.tenant.workspaceId,
    userId: ctx.tenant.userId,
  });

  return { text: result.content, model: result.modelId, usage: result.usage };
}

async function handleAiClassify(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const text = String(inputs.text || inputs.input || '');
  const categories = inputs.categories as string[];
  if (!text) throw new Error('Text input is required');
  if (!categories || !Array.isArray(categories) || categories.length === 0) throw new Error('Categories array is required');

  const model = inputs.model ? String(inputs.model) : undefined;
  const modelId = model && !model.includes('/') ? `openai/${model}` : model;

  const result = await callAiGateway(ctx.env, [
    { role: 'system', content: `You are a text classifier. Classify the given text into exactly one of these categories: ${categories.join(', ')}. Respond with JSON only: {"category": "<chosen_category>", "confidence": "high|medium|low", "reasoning": "<brief explanation>"}` },
    { role: 'user', content: text },
  ], { modelId, temperature: 0, maxTokens: 500, workspaceId: ctx.tenant.workspaceId, userId: ctx.tenant.userId });

  const parsed = JSON.parse(result.content || '{}') as { category?: string; confidence?: string; reasoning?: string };
  return { category: parsed.category || 'unknown', confidence: parsed.confidence || 'low', reasoning: parsed.reasoning || '' };
}

// ============================================================================
// Helpdesk Conversation Helpers
// ============================================================================

function resolveConversationId(inputs: Record<string, unknown>, context: ActionContext): string | null {
  if (inputs.conversationId) return String(inputs.conversationId);
  const td = context.triggerData as Record<string, unknown> | undefined;
  if (td?.entityType === 'helpdesk_conversation') return String(td.entityId);
  if (td?.data && typeof td.data === 'object' && 'conversationId' in (td.data as object)) {
    return String((td.data as Record<string, unknown>).conversationId);
  }
  return null;
}

async function handleAssignConversation(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const strategy = String(inputs.strategy || 'specific_agent');
  const departmentId = inputs.departmentId ? String(inputs.departmentId) : undefined;
  const updateData: Record<string, unknown> = { updatedAt: new Date() };

  if (strategy === 'specific_agent' && inputs.agentId) {
    updateData.assigneeId = String(inputs.agentId);
    if (inputs.agentName) updateData.assigneeName = String(inputs.agentName);
  } else if (strategy === 'department' && departmentId) {
    updateData.departmentId = departmentId;
  } else if (strategy === 'round_robin' || strategy === 'least_busy') {
    const conditions: any[] = [eq(schema.helpdeskAgents.status, 'active'), isNull(schema.helpdeskAgents.deletedAt)];
    if (departmentId) conditions.push(eq(schema.helpdeskAgents.departmentId, departmentId));

    const orderCol = strategy === 'round_robin' ? schema.helpdeskAgents.ticketsAssigned : schema.helpdeskAgents.currentActiveTickets;
    const agents = await ctx.db.select({ id: schema.helpdeskAgents.id, userId: schema.helpdeskAgents.userId, name: schema.helpdeskAgents.name })
      .from(schema.helpdeskAgents).where(and(...conditions)).orderBy(asc(orderCol)).limit(1);

    if (!agents[0]) return { success: false, error: 'No available agents' };
    updateData.assigneeId = agents[0].userId;
    updateData.assigneeName = agents[0].name;

    await ctx.db.update(schema.helpdeskAgents).set({
      ticketsAssigned: sql`COALESCE(${schema.helpdeskAgents.ticketsAssigned}, 0) + 1`,
      currentActiveTickets: sql`COALESCE(${schema.helpdeskAgents.currentActiveTickets}, 0) + 1`,
      updatedAt: new Date(),
    }).where(eq(schema.helpdeskAgents.id, agents[0].id));
  }

  await ctx.db.update(schema.helpdeskConversations).set(updateData).where(eq(schema.helpdeskConversations.id, conversationId));

  if (updateData.assigneeId) {
    await publishRealtime(ctx.env, ctx.tenant.workspaceId, `conversation:${conversationId}`, 'agent:assigned', {
      conversationId, agentId: updateData.assigneeId, agentName: updateData.assigneeName || 'Agent',
    });
  }

  return { success: true, conversationId, strategy, ...updateData };
}

async function handleTagConversation(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const mode = String(inputs.mode || 'add');
  const inputTags = (Array.isArray(inputs.tags) ? inputs.tags : []).map(String);

  const [conversation] = await ctx.db.select({ tags: schema.helpdeskConversations.tags })
    .from(schema.helpdeskConversations).where(eq(schema.helpdeskConversations.id, conversationId)).limit(1);

  const currentTags: string[] = (conversation?.tags as string[]) ?? [];
  let newTags: string[];

  switch (mode) {
    case 'add': newTags = [...new Set([...currentTags, ...inputTags])]; break;
    case 'remove': newTags = currentTags.filter(t => !inputTags.includes(t)); break;
    case 'replace': newTags = inputTags; break;
    default: newTags = [...new Set([...currentTags, ...inputTags])];
  }

  await ctx.db.update(schema.helpdeskConversations).set({ tags: newTags, updatedAt: new Date() }).where(eq(schema.helpdeskConversations.id, conversationId));
  return { success: true, conversationId, mode, tags: newTags };
}

async function handleChangeConversationStatus(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const status = String(inputs.status);
  const updateData: Record<string, unknown> = { status, updatedAt: new Date() };
  if (status === 'resolved') updateData.resolvedAt = new Date();
  if (status === 'closed') updateData.closedAt = new Date();

  await ctx.db.update(schema.helpdeskConversations).set(updateData).where(eq(schema.helpdeskConversations.id, conversationId));
  return { success: true, conversationId, status };
}

async function handleChangePriority(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const priority = String(inputs.priority);
  await ctx.db.update(schema.helpdeskConversations).set({ priority, updatedAt: new Date() }).where(eq(schema.helpdeskConversations.id, conversationId));
  return { success: true, conversationId, priority };
}

async function handleSendReply(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const messageId = generateId('msg');
  const authorType = String(inputs.authorType || 'system');
  const content = String(inputs.message || '');

  await ctx.db.insert(schema.helpdeskConversationMessages).values({
    id: messageId, conversationId, content, authorType,
    authorId: authorType === 'agent' ? ctx.tenant.userId : 'system',
    authorName: authorType === 'agent' ? 'Agent' : 'System',
    type: 'message', isPublic: true, status: 'sent',
    createdAt: new Date(), updatedAt: new Date(),
  });

  await ctx.db.update(schema.helpdeskConversations).set({
    lastMessageAt: new Date(), lastAgentMessageAt: new Date(), updatedAt: new Date(),
  }).where(eq(schema.helpdeskConversations.id, conversationId));

  await publishRealtime(ctx.env, ctx.tenant.workspaceId, `conversation:${conversationId}`, 'message:new', {
    id: messageId, conversationId, content, senderId: authorType === 'agent' ? ctx.tenant.userId : 'system',
    senderName: authorType === 'agent' ? 'Agent' : 'System', sender: 'agent', timestamp: new Date().toISOString(),
  });

  return { success: true, messageId, conversationId };
}

async function handleAddInternalNote(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const messageId = generateId('msg');
  await ctx.db.insert(schema.helpdeskConversationMessages).values({
    id: messageId, conversationId, content: String(inputs.content || ''),
    authorType: 'agent', authorId: ctx.tenant.userId, authorName: 'System',
    type: 'note', isPublic: false, isInternal: true, status: 'sent',
    createdAt: new Date(), updatedAt: new Date(),
  });
  return { success: true, messageId, conversationId };
}

async function handleSendMessage(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const content = String(inputs.message || '');
  const messageId = generateId('msg');
  const now = new Date();

  await ctx.db.insert(schema.helpdeskConversationMessages).values({
    id: messageId, conversationId, content, authorType: 'system', authorId: 'system', authorName: 'Bot',
    type: 'message', isPublic: true, status: 'sent', createdAt: now, updatedAt: now,
  });

  await publishRealtime(ctx.env, ctx.tenant.workspaceId, `conversation:${conversationId}`, 'message:new', {
    id: messageId, conversationId, content, senderId: 'system', senderName: 'Bot', sender: 'agent', timestamp: now.toISOString(),
  });
  return { success: true, messageId, conversationId };
}

async function handleSendChoices(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const content = String(inputs.message || '');
  const options = (inputs.options as Array<{ id: string; label: string; value: string }>) || [];
  const messageId = generateId('msg');
  const now = new Date();
  const metadata = { interactiveType: 'choices', workflowExecutionId: ctx.executionId, workflowStepId: (inputs as any).__stepId || 'unknown', options };

  await ctx.db.insert(schema.helpdeskConversationMessages).values({
    id: messageId, conversationId, content, authorType: 'system', authorId: 'system', authorName: 'Bot',
    type: 'message', isPublic: true, status: 'sent', metadata, createdAt: now, updatedAt: now,
  });

  await publishRealtime(ctx.env, ctx.tenant.workspaceId, `conversation:${conversationId}`, 'message:new', {
    id: messageId, conversationId, content, senderId: 'system', senderName: 'Bot', sender: 'agent', timestamp: now.toISOString(), metadata,
  });

  return { __waitingForInput: true, conversationId, messageId, stepType: 'send_choices' } satisfies WaitingForInputResult;
}

async function handleCollectInput(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const content = String(inputs.message || '');
  const fields = (inputs.fields as Array<{ id: string; label: string; type: string; required: boolean }>) || [];
  const messageId = generateId('msg');
  const now = new Date();
  const metadata = { interactiveType: 'collect_input', workflowExecutionId: ctx.executionId, workflowStepId: (inputs as any).__stepId || 'unknown', fields };

  await ctx.db.insert(schema.helpdeskConversationMessages).values({
    id: messageId, conversationId, content, authorType: 'system', authorId: 'system', authorName: 'Bot',
    type: 'message', isPublic: true, status: 'sent', metadata, createdAt: now, updatedAt: now,
  });

  await publishRealtime(ctx.env, ctx.tenant.workspaceId, `conversation:${conversationId}`, 'message:new', {
    id: messageId, conversationId, content, senderId: 'system', senderName: 'Bot', sender: 'agent', timestamp: now.toISOString(), metadata,
  });

  return { __waitingForInput: true, conversationId, messageId, stepType: 'collect_input' } satisfies WaitingForInputResult;
}

async function handleManualStep(inputs: Record<string, unknown>, ctx: ActionContext): Promise<WaitingForInputResult> {
  const title = String(inputs.title || 'Manual Review Required');
  let targetUserId = ctx.tenant.userId;
  if (inputs.assignTo === 'specific_user' && inputs.assigneeId) targetUserId = String(inputs.assigneeId);

  const notificationId = generateId('notif');
  // No workspaceId — tenant `notifications` table has no workspace_id column.
  await ctx.db.insert(schema.notifications).values({
    id: notificationId, userId: targetUserId, title,
    body: inputs.description ? String(inputs.description) : 'A workflow step requires your action.',
    category: 'task', notificationType: 'manual_step', entityType: 'workflow_execution',
    entityId: ctx.executionId, actionUrl: `/task/workflows/executions/${ctx.executionId}`,
    severity: 'info', data: { stepConfig: inputs }, isRead: false,
    deliveredInApp: true, deliveredEmail: false, deliveredPush: false, createdAt: new Date(),
  });

  return { __waitingForInput: true, stepType: 'manual_step' };
}

// ============================================================================
// Action Handler Registry
// ============================================================================

export const actionHandlers: Record<string, ActionHandler> = {
  // Communication
  send_email: handleSendEmail,
  send_notification: handleSendNotification,
  send_sms: handleSendSms,
  // Data
  create_record: handleCreateRecord,
  update_record: handleUpdateRecord,
  delete_record: handleDeleteRecord,
  query_data: handleQueryData,
  // Logic
  set_variable: handleSetVariable,
  loop: handleLoop,
  condition: handleCondition,
  delay: handleDelay,
  transform: handleTransform,
  // Integration
  webhook: handleWebhook,
  http_request: handleHttpRequest,
  // AI
  ai_generate: handleAiGenerate,
  ai_classify: handleAiClassify,
  // Utility
  log: handleLog,
  // Helpdesk
  assign_conversation: handleAssignConversation,
  tag_conversation: handleTagConversation,
  change_conversation_status: handleChangeConversationStatus,
  change_priority: handleChangePriority,
  send_reply: handleSendReply,
  add_internal_note: handleAddInternalNote,
  // Human-in-the-loop
  manual_step: handleManualStep,
  // Chat widget interactive steps
  send_message: handleSendMessage,
  send_choices: handleSendChoices,
  collect_input: handleCollectInput,
};

export async function executeAction(
  actionType: string,
  inputs: Record<string, unknown>,
  context: ActionContext,
): Promise<unknown> {
  const handler = actionHandlers[actionType];
  if (!handler) {
    console.warn(`Unknown action type: ${actionType}, executing as passthrough`);
    return { executed: true, type: actionType, inputs };
  }
  return handler(inputs, context);
}
