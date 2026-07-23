/**
 * HTTP actions: http_request, webhook.
 *
 * Both can optionally authenticate using a connected integration: when
 * `integrationId`/`integrationType` is supplied, an `Authorization: Bearer
 * <token>` header is injected from the integration (an explicit
 * `headers.Authorization` always wins).
 */

import type { ActionHandler, ActionContext } from '../types';
import { resolveIntegration, integrationBearerToken } from '../integrations';

/** Merge integration-derived auth into the caller's headers (explicit wins). */
async function withIntegrationAuth(
  inputs: Record<string, unknown>,
  ctx: ActionContext,
  headers: Record<string, string>,
): Promise<Record<string, string>> {
  const integrationId = inputs.integrationId ? String(inputs.integrationId) : undefined;
  const integrationType = inputs.integrationType ? String(inputs.integrationType) : undefined;
  if (!integrationId && !integrationType) return headers;

  const hasExplicitAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
  if (hasExplicitAuth) return headers;

  const integ = await resolveIntegration(ctx.db, { integrationId, type: integrationType });
  const token = integrationBearerToken(integ);
  if (token) return { ...headers, Authorization: `Bearer ${token}` };
  return headers;
}

export const handleHttpRequest: ActionHandler = async (inputs, ctx) => {
  const url = String(inputs.url || '');
  const method = String(inputs.method || 'GET').toUpperCase();
  const baseHeaders = (inputs.headers as Record<string, string>) || {};
  const body = inputs.body;
  const timeout = Number(inputs.timeout) || 30000;
  if (!url) throw new Error('URL is required');

  const headers = await withIntegrationAuth(inputs, ctx, baseHeaders);

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
    try {
      parsedData = JSON.parse(responseText);
    } catch {
      parsedData = responseText;
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      data: parsedData,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeout}ms`);
    }
    throw error;
  }
};

export const handleWebhook: ActionHandler = async (inputs, ctx) => {
  const url = String(inputs.url || inputs.webhookUrl || '');
  const method = String(inputs.method || 'POST').toUpperCase();
  const baseHeaders = (inputs.headers || {}) as Record<string, string>;
  const body = inputs.body || inputs.payload || inputs.data;
  if (!url) throw new Error('Webhook URL is required');

  const headers = await withIntegrationAuth(inputs, ctx, baseHeaders);

  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const responseText = await response.text();
  let responseData: unknown;
  try {
    responseData = JSON.parse(responseText);
  } catch {
    responseData = responseText;
  }

  if (!response.ok) {
    throw new Error(`Webhook failed: ${response.status} - ${responseText.slice(0, 200)}`);
  }
  return { success: true, status: response.status, response: responseData };
};
