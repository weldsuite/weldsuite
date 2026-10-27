/**
 * Records a person tags in a message to an agent (WeldChat, the agent chat,
 * the side panel). A tag is stored in the text as `<@type:id|Label>`, the
 * WeldChat entity token, e.g. `<@sheet:sht_1|Budget>`.
 *
 * Agents get the tag spelled out (`spreadsheet "Budget" (id sht_1)`), so a
 * model reads which record is meant and has the id for its tools.
 */

import {
  SEARCH_ENTITY_TYPES_SET,
  type SearchEntityType,
} from '@weldsuite/app-api-client/schemas/search';

/** How each record type is called in the text an agent reads. */
const RECORD_NOUN: Record<SearchEntityType, string> = {
  contact: 'person',
  customer: 'company',
  lead: 'lead',
  opportunity: 'opportunity',
  ticket: 'ticket',
  article: 'help center article',
  knowledge_page: 'knowledge page',
  product: 'product',
  order: 'order',
  invoice: 'invoice',
  bill: 'bill',
  project: 'project',
  task: 'task',
  domain: 'domain',
  sheet: 'spreadsheet',
};

export interface TaggedRecord {
  type: SearchEntityType;
  id: string;
  label: string | null;
}

const TOKEN = /<@([^>]+)>/g;

/** The record a token body (`type:id|Label`) names, or null for a person, an agent or a file. */
function recordOf(body: string): TaggedRecord | null {
  const colon = body.indexOf(':');
  if (colon === -1) return null;
  const type = body.slice(0, colon);
  if (!SEARCH_ENTITY_TYPES_SET.has(type)) return null;
  const rest = body.slice(colon + 1);
  const pipe = rest.indexOf('|');
  const id = (pipe === -1 ? rest : rest.slice(0, pipe)).trim();
  if (!id) return null;
  const label = pipe === -1 ? '' : rest.slice(pipe + 1).trim();
  return { type: type as SearchEntityType, id, label: label || null };
}

/** The records tagged in `text`, in order, each once. */
export function taggedRecords(text: string): TaggedRecord[] {
  const found: TaggedRecord[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const record = recordOf(match[1]);
    if (record && !found.some((r) => r.type === record.type && r.id === record.id)) found.push(record);
  }
  return found;
}

/** `text` with every record tag spelled out for a model; other tokens stay as they are. */
export function describeRecordTokens(text: string): string {
  return text.replace(TOKEN, (raw, body: string) => {
    const record = recordOf(body);
    if (!record) return raw;
    const noun = RECORD_NOUN[record.type];
    return record.label ? `${noun} "${record.label}" (id ${record.id})` : `${noun} (id ${record.id})`;
  });
}

type Turn = { role: 'user' | 'assistant'; content: string };

/** The spreadsheets the user tagged in their messages, oldest first, each once. */
export function taggedSheetsIn(messages: readonly Turn[]): Array<{ id: string; label: string | null }> {
  const sheets = new Map<string, string | null>();
  for (const message of messages) {
    if (message.role !== 'user') continue;
    for (const record of taggedRecords(message.content)) {
      if (record.type === 'sheet' && !sheets.has(record.id)) sheets.set(record.id, record.label);
    }
  }
  return [...sheets].map(([id, label]) => ({ id, label }));
}

/** The messages with the user's record tags spelled out, for a model to read. */
export function describeUserTags<T extends Turn>(messages: readonly T[]): T[] {
  return messages.map((message) =>
    message.role === 'user' ? { ...message, content: describeRecordTokens(message.content) } : message,
  );
}
