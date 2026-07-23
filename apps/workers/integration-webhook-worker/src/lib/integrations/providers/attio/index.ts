import type { IntegrationProvider, ExternalRecord, ExternalNote, ExternalTask, ExternalList, ExternalListEntry, ParsedWebhookPayload, ParsedWebhookEvent, MappedCompany, MappedPerson } from '../../types';
import {
  mapAttioCompany,
  mapAttioPerson,
} from './mapper';

const ATTIO_API_BASE = 'https://api.attio.com/v2';

// In-memory cache for object_id UUID → slug mapping (per worker instance)
const objectSlugCache = new Map<string, string>();

/**
 * Attio integration provider for webhook processing.
 */
export class AttioProvider implements IntegrationProvider {
  /**
   * Verify Attio webhook signature using HMAC-SHA256.
   */
  async verifyWebhookSignature(
    body: string,
    headers: Record<string, string>,
    secret: string
  ): Promise<boolean> {
    const signature = headers['attio-signature'] || headers['x-attio-signature'];
    if (!signature) return false;

    try {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );

      const signatureBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
      const expectedSignature = Array.from(new Uint8Array(signatureBytes))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      // Constant-time comparison
      if (signature.length !== expectedSignature.length) return false;
      let mismatch = 0;
      for (let i = 0; i < signature.length; i++) {
        mismatch |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
      }
      return mismatch === 0;
    } catch (err) {
      console.error('[Attio] Signature verification error:', err);
      return false;
    }
  }

  /**
   * Parse Attio webhook payload.
   * Handles both record events and note events.
   *
   * Record events: { event_type: "record.*", id: { object_id, record_id } }
   * Note events:   { event_type: "note.*", id: { note_id }, parent_object_id, parent_record_id }
   */
  parseWebhookPayload(body: string): ParsedWebhookPayload {
    const payload = JSON.parse(body);

    const events: ParsedWebhookEvent[] = (payload.events || []).map((evt: any) => {
      const eventType = evt.event_type as string;

      if (eventType.startsWith('note.')) {
        return {
          eventType,
          objectId: '',
          objectType: '',
          recordId: '',
          noteId: evt.id?.note_id || '',
          parentObjectId: evt.parent_object_id || '',
          parentRecordId: evt.parent_record_id || '',
        } as ParsedWebhookEvent;
      }

      if (eventType.startsWith('task.')) {
        return {
          eventType,
          objectId: '',
          objectType: '',
          recordId: '',
          taskId: evt.id?.task_id || '',
        } as ParsedWebhookEvent;
      }

      if (eventType.startsWith('list-entry.')) {
        return {
          eventType,
          objectId: '',
          objectType: '',
          recordId: '',
          listEntryId: evt.id?.entry_id || '',
          listId: evt.id?.list_id || '',
          parentRecordId: evt.parent_record_id || '',
        } as ParsedWebhookEvent;
      }

      return {
        eventType,
        objectId: evt.id?.object_id || '',
        objectType: '', // resolved later via resolveObjectSlug
        recordId: evt.id?.record_id || '',
        mergedFromId: evt.merged_from?.id?.record_id,
      } as ParsedWebhookEvent;
    });

    return {
      webhookId: payload.webhook_id || '',
      events,
    };
  }

  /**
   * Resolve an Attio object UUID to its API slug (e.g., "people", "companies").
   * Results are cached in memory.
   */
  async resolveObjectSlug(accessToken: string, objectId: string): Promise<string> {
    const cached = objectSlugCache.get(objectId);
    if (cached) return cached;

    const response = await fetch(`${ATTIO_API_BASE}/objects/${objectId}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      console.warn(`[Attio] Failed to resolve object ${objectId}: ${response.status}`);
      return objectId; // fallback to UUID
    }

    const result = await response.json() as { data: { api_slug: string } };
    const slug = result.data.api_slug;
    objectSlugCache.set(objectId, slug);
    return slug;
  }

  /**
   * Fetch a full record from Attio's API.
   * Accepts either a slug ("people") or UUID for objectType.
   */
  async fetchRecord(accessToken: string, objectType: string, recordId: string): Promise<ExternalRecord> {
    const url = `${ATTIO_API_BASE}/objects/${objectType}/records/${recordId}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Attio API error ${response.status}: ${errorText}`);
    }

    const result = await response.json() as { data: { id: { record_id: string }; values: Record<string, unknown> } };

    return {
      id: result.data.id.record_id,
      type: objectType === 'companies' ? 'company' : 'person',
      data: result.data.values,
      raw: result.data,
    };
  }

  /**
   * Fetch a note from Attio's API.
   * GET /v2/notes/:noteId
   */
  async fetchNote(accessToken: string, noteId: string): Promise<ExternalNote> {
    const url = `${ATTIO_API_BASE}/notes/${noteId}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Attio notes API error ${response.status}: ${errorText}`);
    }

    const result = await response.json() as {
      data: {
        id: { note_id: string };
        parent_object: string;
        parent_record_id: string;
        title: string;
        content_plaintext: string;
        content_markdown?: string;
        created_at: string;
      };
    };

    return {
      id: result.data.id.note_id,
      parentObject: result.data.parent_object,
      parentRecordId: result.data.parent_record_id,
      title: result.data.title || 'Untitled Note',
      content: result.data.content_plaintext || '',
      createdAt: result.data.created_at,
      raw: result.data,
    };
  }

  /**
   * Fetch a task from Attio's API.
   * GET /v2/tasks/:taskId
   */
  async fetchTask(accessToken: string, taskId: string): Promise<ExternalTask> {
    const url = `${ATTIO_API_BASE}/tasks/${taskId}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Attio tasks API error ${response.status}: ${errorText}`);
    }

    const result = await response.json() as {
      data: {
        id: { task_id: string };
        content: string;
        is_completed: boolean;
        deadline_at: string | null;
        linked_records: Array<{ target_object: string; target_record_id: string }>;
        assignees: Array<{ referenced_actor_type: string; referenced_actor_id: string }>;
        created_at: string;
      };
    };

    return {
      id: result.data.id.task_id,
      content: result.data.content || '',
      isCompleted: result.data.is_completed,
      deadlineAt: result.data.deadline_at,
      linkedRecords: (result.data.linked_records || []).map(lr => ({
        targetObject: lr.target_object,
        targetRecordId: lr.target_record_id,
      })),
      assignees: (result.data.assignees || []).map(a => ({
        referencedActorType: a.referenced_actor_type,
        referencedActorId: a.referenced_actor_id,
      })),
      createdAt: result.data.created_at,
      raw: result.data,
    };
  }

  /**
   * Fetch all lists from Attio's API.
   * GET /v2/lists
   */
  async fetchLists(accessToken: string): Promise<ExternalList[]> {
    const url = `${ATTIO_API_BASE}/lists`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Attio lists API error ${response.status}: ${errorText}`);
    }

    const result = await response.json() as {
      data: Array<{
        id: { list_id: string };
        name: string;
        api_slug: string;
        parent_object: string;
      }>;
    };

    return result.data.map(list => ({
      listId: list.id.list_id,
      name: list.name,
      apiSlug: list.api_slug,
      parentObject: list.parent_object,
    }));
  }

  /**
   * Fetch a list entry from Attio's API.
   * GET /v2/lists/:listId/entries/:entryId
   */
  async fetchListEntry(accessToken: string, listId: string, entryId: string): Promise<ExternalListEntry> {
    const url = `${ATTIO_API_BASE}/lists/${listId}/entries/${entryId}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Attio list entry API error ${response.status}: ${errorText}`);
    }

    const result = await response.json() as {
      data: {
        id: { entry_id: string; list_id: string };
        parent_record_id: string;
        parent_object: string;
        entry_values: Record<string, unknown>;
      };
    };

    return {
      entryId: result.data.id.entry_id,
      listId: result.data.id.list_id,
      parentRecordId: result.data.parent_record_id,
      parentObject: result.data.parent_object,
      entryValues: result.data.entry_values || {},
      raw: result.data,
    };
  }

  mapCompany(record: ExternalRecord): MappedCompany {
    return mapAttioCompany(record);
  }

  mapPerson(record: ExternalRecord): MappedPerson {
    return mapAttioPerson(record);
  }
}
