/**
 * Airtable outbound actions (`airtable.create_record`, `airtable.update_record`).
 */

import type { ActionHandler } from '../../types';
import { getIntegrationCredentials } from './token';

function parseJsonObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string' && v.trim()) {
    try {
      const p = JSON.parse(v);
      if (p && typeof p === 'object') return p as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  return {};
}

async function airtableToken(ctx: Parameters<ActionHandler>[1], integrationId: unknown): Promise<string> {
  const { credentials } = await getIntegrationCredentials(ctx, {
    type: 'airtable',
    integrationId: integrationId ? String(integrationId) : undefined,
  });
  if (!credentials.token) throw new Error('Airtable integration has no token');
  return credentials.token;
}

export const handleAirtableCreateRecord: ActionHandler = async (inputs, ctx) => {
  const baseId = String(inputs.baseId || '');
  const tableId = String(inputs.tableId || '');
  if (!baseId || !tableId) throw new Error('Airtable baseId and tableId are required');
  const fields = parseJsonObject(inputs.fields);

  const token = await airtableToken(ctx, inputs.integrationId);
  const res = await fetch(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableId)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  const json = (await res.json()) as { id?: string; error?: unknown };
  if (!res.ok) throw new Error(`Airtable create failed: ${JSON.stringify(json.error) || res.status}`);
  return { created: true, id: json.id };
};

export const handleAirtableUpdateRecord: ActionHandler = async (inputs, ctx) => {
  const baseId = String(inputs.baseId || '');
  const tableId = String(inputs.tableId || '');
  const recordId = String(inputs.recordId || '');
  if (!baseId || !tableId || !recordId) throw new Error('Airtable baseId, tableId and recordId are required');
  const fields = parseJsonObject(inputs.fields);

  const token = await airtableToken(ctx, inputs.integrationId);
  const res = await fetch(
    `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableId)}/${recordId}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    },
  );
  const json = (await res.json()) as { id?: string; error?: unknown };
  if (!res.ok) throw new Error(`Airtable update failed: ${JSON.stringify(json.error) || res.status}`);
  return { updated: true, id: json.id };
};
