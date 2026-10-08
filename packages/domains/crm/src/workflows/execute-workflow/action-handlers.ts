/**
 * Action handlers for WeldConnect workflow step execution.
 *
 * Ported from apps/api-worker/src/workflows/execute-workflow/action-handlers.ts
 * (W4 legacy-worker phase-out). Adaptations for app-api:
 *  - `ActionEnv` names only the bindings these handlers read (moved from
 *    app-api to @weldsuite/crm-domain with the ExecuteSequence workflow)
 *  - send_email posts through the worker's own Cloudflare send binding
 *    (`@weldsuite/worker-email`) instead of an HTTP round-trip to api-worker's
 *    /api/internal/send-email endpoint
 *  - ai_generate / ai_classify run through `@weldsuite/ai` + the prepaid
 *    credit wallet (`@weldsuite/core-domain/ai-billing`) — api-worker's `services/ai`
 *    facade was gutted in the AI teardown and its dynamic `generate` import
 *    would throw at runtime
 */

import { eq, and, isNull, asc, sql } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { getEntityTable, getEntityIdPrefix } from './entity-tables';
import * as cfEmail from '@weldsuite/worker-email';
import type { WorkerEmailEnv } from '@weldsuite/worker-email';
import type { AiBillingEnv } from '@weldsuite/core-domain/ai-billing';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { asText } from '@weldsuite/text';

// ============================================================================
// Types
// ============================================================================

export type WorkflowDb = NeonHttpDatabase<typeof schema>;

/**
 * The bindings the action handlers read. Any worker Env with them fits:
 * SEND_EMAIL (send_email), REALTIME (helpdesk conversation events),
 * DATABASE_URL_MASTER (AI credit metering), and the AI gateway keys
 * `@weldsuite/ai` reads from the same env (CF_ACCOUNT_ID, AI_GATEWAY_API_TOKEN, …).
 */
export interface ActionEnv extends WorkerEmailEnv, AiBillingEnv {
  /** realtime-worker service binding. */
  REALTIME?: Fetcher;
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_PROVIDER?: string;
  AI_DEFAULT_MODEL?: string;
  AI_GATEWAY_API_TOKEN?: string;
  CF_AI_GATEWAY?: string;
  CF_AIG_TOKEN?: string;
}

export interface ActionContext {
  tenant: { workspaceId: string; userId: string };
  executionId: string;
  db: WorkflowDb;
  env: ActionEnv;
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
  env: ActionEnv,
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
    subject: asText(inputs.subject || ''),
    html: asText(inputs.body || inputs.html || ''),
    text: asText(inputs.body || '').replaceAll(/<[^<>]*>/g, ''),
    cc: inputs.cc as string[] | undefined,
    bcc: inputs.bcc as string[] | undefined,
  });

  return { success: true, messageId: result.messageId, from: (account as any).email };
}

async function handleSendNotification(
  inputs: Record<string, unknown>,
  ctx: ActionContext,
): Promise<unknown> {
  const title = asText(inputs.title || '');
  const body = asText(inputs.body || inputs.message || '');
  if (!title) throw new Error('Notification title is required');

  let userIds: string[] = [];
  if (Array.isArray(inputs.userIds) && inputs.userIds.length > 0) {
    userIds = inputs.userIds.map((id) => asText(id));
  } else if (inputs.userId) {
    userIds = [asText(inputs.userId)];
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
      category: asText(inputs.category || 'task'),
      notificationType: asText(inputs.notificationType || inputs.type || 'custom'),
      entityType: inputs.entityType ? asText(inputs.entityType) : null,
      entityId: inputs.entityId ? asText(inputs.entityId) : null,
      actionUrl: inputs.actionUrl ? asText(inputs.actionUrl) : null,
      icon: inputs.icon ? asText(inputs.icon) : null,
      severity: asText(inputs.severity || 'info'),
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
  const entityType = asText(inputs.entity || inputs.entityType || '');
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
  const entityType = asText(inputs.entity || inputs.entityType || '');
  const recordId = asText(inputs.id || inputs.recordId || '');
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
  const entityType = asText(inputs.entity || inputs.entityType || '');
  const recordId = asText(inputs.id || inputs.recordId || '');
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
  const entityType = asText(inputs.entity || inputs.entityType || '');
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
          case 'contains': return asText(record[key]).includes(asText(op.value));
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

function handleSetVariable(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const varName = asText(inputs.name || inputs.variableName || '');
  if (!varName) throw new Error('Variable name is required');
  ctx.variables[varName] = inputs.value;
  return Promise.resolve({ set: true, name: varName, value: inputs.value });
}

function handleLoop(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const items = inputs.items as unknown[];
  const iteratorName = asText(inputs.iteratorName || 'item');
  if (!Array.isArray(items)) throw new Error('Items must be an array');

  const results: unknown[] = [];
  for (let i = 0; i < items.length; i++) {
    ctx.variables[iteratorName] = items[i];
    ctx.variables[`${iteratorName}Index`] = i;
    results.push({ index: i, item: items[i], processed: true });
  }
  return Promise.resolve({ items: results, count: results.length });
}

async function handleWebhook(inputs: Record<string, unknown>, _ctx: ActionContext): Promise<unknown> {
  const url = asText(inputs.url || inputs.webhookUrl || '');
  const method = asText(inputs.method || 'POST').toUpperCase();
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

function handleLog(inputs: Record<string, unknown>): Promise<unknown> {
  const message = asText(inputs.message || inputs.text || '');
  const level = asText(inputs.level || 'info').toLowerCase();
  switch (level) {
    case 'error': console.error(`[LOG] ${message}`); break;
    case 'warn': case 'warning': console.warn(`[LOG] ${message}`); break;
    default: console.log(`[LOG] ${message}`);
  }
  return Promise.resolve({ logged: true, message });
}

function handleDelay(inputs: Record<string, unknown>): Promise<unknown> {
  // Note: actual sleep is handled by the CF Workflow step.sleep() in the main executor.
  // This handler just returns the duration for the caller to use.
  let durationMs = 1000;
  let durationDescription = '1 second';

  if (inputs.days && Number(inputs.days) > 0) {
    durationMs = Number(inputs.days) * 86400000;
    durationDescription = `${asText(inputs.days)} day(s)`;
  } else if (inputs.hours && Number(inputs.hours) > 0) {
    durationMs = Number(inputs.hours) * 3600000;
    durationDescription = `${asText(inputs.hours)} hour(s)`;
  } else if (inputs.minutes && Number(inputs.minutes) > 0) {
    durationMs = Number(inputs.minutes) * 60000;
    durationDescription = `${asText(inputs.minutes)} minute(s)`;
  } else if (inputs.seconds && Number(inputs.seconds) > 0) {
    durationMs = Number(inputs.seconds) * 1000;
    durationDescription = `${asText(inputs.seconds)} second(s)`;
  } else if (inputs.duration || inputs.ms) {
    durationMs = Number(inputs.duration || inputs.ms || 1000);
    durationDescription = `${Math.ceil(durationMs / 1000)} second(s)`;
  }

  return Promise.resolve({ delayed: true, duration: durationDescription, durationMs, __delayMs: durationMs });
}

async function handleHttpRequest(inputs: Record<string, unknown>): Promise<unknown> {
  const url = asText(inputs.url);
  const method = asText(inputs.method || 'GET').toUpperCase();
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

function handleTransform(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const transform = asText(inputs.transform || inputs.operation || 'pick');
  const data = inputs.data || ctx.previousResults;

  switch (transform) {
    case 'pick': {
      const fields = inputs.fields as string[];
      if (!fields || !Array.isArray(fields)) throw new Error('Fields array is required for pick');
      const result: Record<string, unknown> = {};
      for (const field of fields) result[field] = (data as Record<string, unknown>)[field];
      return Promise.resolve(result);
    }
    case 'map': {
      const sourceArray = inputs.source || data;
      if (!Array.isArray(sourceArray)) throw new Error('Source must be an array for map');
      return Promise.resolve(sourceArray.map((item: any) => item[asText(inputs.mapField || 'id')]));
    }
    case 'filter': {
      const sourceArray = inputs.source || data;
      if (!Array.isArray(sourceArray)) throw new Error('Source must be an array for filter');
      return Promise.resolve(sourceArray.filter((item: any) => item[asText(inputs.filterField || '')] === inputs.filterValue));
    }
    case 'merge': {
      const objects = inputs.objects as Record<string, unknown>[];
      if (!Array.isArray(objects)) throw new Error('Objects array is required for merge');
      return Promise.resolve(Object.assign({}, ...objects));
    }
    case 'stringify': return Promise.resolve(JSON.stringify(data));
    case 'parse': return Promise.resolve(typeof data === 'string' ? JSON.parse(data) : data);
    default: return Promise.resolve(data);
  }
}

function resolveConditionField(field: unknown, inputs: Record<string, unknown>, ctx: ActionContext): unknown {
  if (!field || typeof field !== 'string') return undefined;
  if (field.startsWith('steps.')) {
    const [, stepId, ...rest] = field.split('.');
    const stepOutput = ctx.previousResults[stepId] as Record<string, unknown>;
    return rest.reduce((obj: any, prop) => obj?.[prop], stepOutput);
  }
  if (field.startsWith('trigger.')) {
    const props = field.slice(8).split('.');
    return props.reduce((obj: any, prop) => obj?.[prop], ctx.triggerData);
  }
  if (field.startsWith('variables.')) return ctx.variables[field.slice(10)];
  if (field.startsWith('loop.')) {
    const prop = field.slice(5);
    if (prop === 'item') return ctx.loopItem;
    return prop === 'index' ? ctx.loopIndex : undefined;
  }
  return inputs[field];
}

function applyConditionOperator(operator: string, fieldValue: unknown, value: unknown): boolean {
  switch (operator) {
    case 'eq': case 'equals': return fieldValue === value;
    case 'neq': case 'not_equals': return fieldValue !== value;
    case 'gt': case 'greater_than': return Number(fieldValue) > Number(value);
    case 'gte': case 'greater_than_or_equals': return Number(fieldValue) >= Number(value);
    case 'lt': case 'less_than': return Number(fieldValue) < Number(value);
    case 'lte': case 'less_than_or_equals': return Number(fieldValue) <= Number(value);
    case 'contains': return asText(fieldValue).includes(asText(value));
    case 'starts_with': return asText(fieldValue).startsWith(asText(value));
    case 'ends_with': return asText(fieldValue).endsWith(asText(value));
    case 'exists': return fieldValue !== undefined && fieldValue !== null;
    case 'not_exists': return fieldValue === undefined || fieldValue === null;
    case 'in': return Array.isArray(value) && value.includes(fieldValue);
    case 'not_in': return !Array.isArray(value) || !value.includes(fieldValue);
    case 'matches': return new RegExp(asText(value)).test(asText(fieldValue));
    default: return true;
  }
}

function handleCondition(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const operator = asText(inputs.operator || 'eq');
  const fieldValue = resolveConditionField(inputs.field, inputs, ctx);
  const passed = applyConditionOperator(operator, fieldValue, inputs.value);
  return Promise.resolve({ passed, result: fieldValue });
}

function handleSendSms(inputs: Record<string, unknown>): Promise<unknown> {
  const to = asText(inputs.to || inputs.phoneNumber || '');
  const body = asText(inputs.body || inputs.message || '');
  if (!to) throw new Error('Phone number is required');
  if (!body) throw new Error('Message body is required');
  // TODO: Integrate with Telnyx SMS API via env.TELNYX_API_KEY
  return Promise.resolve({ sent: true, message: 'SMS queued (Telnyx integration pending)', status: 'pending' });
}

// ============================================================================
// AI Handlers — @weldsuite/ai (Cloudflare AI Gateway) + prepaid credit wallet.
// api-worker delegated to its `services/ai` facade, which the AI teardown
// emptied; this is the app-api rebuild of the same contract.
// ============================================================================

async function callAiGateway(
  env: ActionEnv,
  messages: Array<{ role: string; content: string }>,
  opts: { modelId?: string; temperature?: number; maxTokens?: number; workspaceId: string; userId: string },
): Promise<{ content: string; modelId: string; usage: unknown; creditsUsed?: number }> {
  const { createWeldAI, generateText, isGatewayConfigured, recommended } = await import('@weldsuite/ai');
  const { resolveAiMetering, assertAiCredits, chargeAiUsage } = await import('@weldsuite/core-domain/ai-billing');

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
  const prompt = asText(inputs.prompt || '');
  if (!prompt) throw new Error('Prompt is required');

  const model = inputs.model ? asText(inputs.model) : undefined;
  const modelId = model && !model.includes('/') ? `openai/${model}` : model;
  const messages: Array<{ role: string; content: string }> = [];
  if (inputs.systemPrompt) messages.push({ role: 'system', content: asText(inputs.systemPrompt) });
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
  const text = asText(inputs.text || inputs.input || '');
  const categories = inputs.categories as string[];
  if (!text) throw new Error('Text input is required');
  if (!categories || !Array.isArray(categories) || categories.length === 0) throw new Error('Categories array is required');

  const model = inputs.model ? asText(inputs.model) : undefined;
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
  if (inputs.conversationId) return asText(inputs.conversationId);
  const td = context.triggerData as Record<string, unknown> | undefined;
  if (td?.entityType === 'helpdesk_conversation') return asText(td.entityId);
  if (td?.data && typeof td.data === 'object' && 'conversationId' in (td.data as object)) {
    return asText((td.data as Record<string, unknown>).conversationId);
  }
  return null;
}

/**
 * Picks the least-loaded active agent (optionally within a department), records the
 * assignee on `updateData` and bumps the agent's counters. False when no agent is available.
 */
async function assignFromAgentPool(
  ctx: ActionContext,
  strategy: 'round_robin' | 'least_busy',
  departmentId: string | undefined,
  updateData: Record<string, unknown>,
): Promise<boolean> {
  const conditions: any[] = [eq(schema.helpdeskAgents.status, 'active'), isNull(schema.helpdeskAgents.deletedAt)];
  if (departmentId) conditions.push(eq(schema.helpdeskAgents.departmentId, departmentId));

  const orderCol = strategy === 'round_robin' ? schema.helpdeskAgents.ticketsAssigned : schema.helpdeskAgents.currentActiveTickets;
  const agents = await ctx.db.select({ id: schema.helpdeskAgents.id, userId: schema.helpdeskAgents.userId, name: schema.helpdeskAgents.name })
    .from(schema.helpdeskAgents).where(and(...conditions)).orderBy(asc(orderCol)).limit(1);

  if (!agents[0]) return false;
  updateData.assigneeId = agents[0].userId;
  updateData.assigneeName = agents[0].name;

  await ctx.db.update(schema.helpdeskAgents).set({
    ticketsAssigned: sql`COALESCE(${schema.helpdeskAgents.ticketsAssigned}, 0) + 1`,
    currentActiveTickets: sql`COALESCE(${schema.helpdeskAgents.currentActiveTickets}, 0) + 1`,
    updatedAt: new Date(),
  }).where(eq(schema.helpdeskAgents.id, agents[0].id));
  return true;
}

async function handleAssignConversation(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const strategy = asText(inputs.strategy || 'specific_agent');
  const departmentId = inputs.departmentId ? asText(inputs.departmentId) : undefined;
  const updateData: Record<string, unknown> = { updatedAt: new Date() };

  if (strategy === 'specific_agent' && inputs.agentId) {
    updateData.assigneeId = asText(inputs.agentId);
    if (inputs.agentName) updateData.assigneeName = asText(inputs.agentName);
  } else if (strategy === 'department' && departmentId) {
    updateData.departmentId = departmentId;
  } else if (strategy === 'round_robin' || strategy === 'least_busy') {
    const assigned = await assignFromAgentPool(ctx, strategy, departmentId, updateData);
    if (!assigned) return { success: false, error: 'No available agents' };
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

  const mode = asText(inputs.mode || 'add');
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

  const status = asText(inputs.status);
  const updateData: Record<string, unknown> = { status, updatedAt: new Date() };
  if (status === 'resolved') updateData.resolvedAt = new Date();
  if (status === 'closed') updateData.closedAt = new Date();

  await ctx.db.update(schema.helpdeskConversations).set(updateData).where(eq(schema.helpdeskConversations.id, conversationId));
  return { success: true, conversationId, status };
}

async function handleChangePriority(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const priority = asText(inputs.priority);
  await ctx.db.update(schema.helpdeskConversations).set({ priority, updatedAt: new Date() }).where(eq(schema.helpdeskConversations.id, conversationId));
  return { success: true, conversationId, priority };
}

async function handleSendReply(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const messageId = generateId('msg');
  const authorType = asText(inputs.authorType || 'system');
  const content = asText(inputs.message || '');

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
    id: messageId, conversationId, content: asText(inputs.content || ''),
    authorType: 'agent', authorId: ctx.tenant.userId, authorName: 'System',
    type: 'note', isPublic: false, isInternal: true, status: 'sent',
    createdAt: new Date(), updatedAt: new Date(),
  });
  return { success: true, messageId, conversationId };
}

async function handleSendMessage(inputs: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const content = asText(inputs.message || '');
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

  const content = asText(inputs.message || '');
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

  const content = asText(inputs.message || '');
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
  const title = asText(inputs.title || 'Manual Review Required');
  let targetUserId = ctx.tenant.userId;
  if (inputs.assignTo === 'specific_user' && inputs.assigneeId) targetUserId = asText(inputs.assigneeId);

  const notificationId = generateId('notif');
  // No workspaceId — tenant `notifications` table has no workspace_id column.
  await ctx.db.insert(schema.notifications).values({
    id: notificationId, userId: targetUserId, title,
    body: inputs.description ? asText(inputs.description) : 'A workflow step requires your action.',
    category: 'task', notificationType: 'manual_step', entityType: 'workflow_execution',
    entityId: ctx.executionId, actionUrl: `/weldconnect/executions/${ctx.executionId}`,
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
