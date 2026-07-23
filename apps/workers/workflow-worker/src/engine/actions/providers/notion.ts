/**
 * Notion outbound actions (`notion.create_page`, `notion.update_page`).
 */

import type { ActionHandler } from '../../types';
import { getIntegrationCredentials } from './token';

const NOTION_VERSION = '2022-06-28';

/** Parse a JSON-object input (object passthrough, JSON string, else {}). */
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

async function notionToken(ctx: Parameters<ActionHandler>[1], integrationId: unknown): Promise<string> {
  const { credentials } = await getIntegrationCredentials(ctx, {
    type: 'notion',
    integrationId: integrationId ? String(integrationId) : undefined,
  });
  if (!credentials.token) throw new Error('Notion integration has no token');
  return credentials.token;
}

export const handleNotionCreatePage: ActionHandler = async (inputs, ctx) => {
  const databaseId = String(inputs.databaseId || '');
  const title = String(inputs.title || '');
  if (!databaseId) throw new Error('Notion databaseId is required');
  if (!title) throw new Error('Notion page title is required');

  const token = await notionToken(ctx, inputs.integrationId);
  const properties = {
    Name: { title: [{ text: { content: title } }] },
    ...parseJsonObject(inputs.properties),
  };

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Notion-Version': NOTION_VERSION },
    body: JSON.stringify({ parent: { database_id: databaseId }, properties }),
  });
  const json = (await res.json()) as { id?: string; url?: string; message?: string };
  if (!res.ok) throw new Error(`Notion create failed: ${json.message || res.status}`);
  return { created: true, id: json.id, url: json.url };
};

export const handleNotionUpdatePage: ActionHandler = async (inputs, ctx) => {
  const pageId = String(inputs.pageId || '');
  if (!pageId) throw new Error('Notion pageId is required');
  const properties = parseJsonObject(inputs.properties);

  const token = await notionToken(ctx, inputs.integrationId);
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Notion-Version': NOTION_VERSION },
    body: JSON.stringify({ properties }),
  });
  const json = (await res.json()) as { id?: string; message?: string };
  if (!res.ok) throw new Error(`Notion update failed: ${json.message || res.status}`);
  return { updated: true, id: json.id };
};
