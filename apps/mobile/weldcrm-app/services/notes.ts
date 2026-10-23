/**
 * Notes: `crm_activities` rows of type `note`, the same rows the platform's
 * Notes page and record Notes tabs show.
 *
 *   list    GET    /activities?type=note[&customerId|contactId|search|cursor]
 *   create  POST   /activities  { type: 'note', subject, description, customerId | contactId, relatedTo* }
 *   update  PATCH  /activities/:id  { subject, description } | { isFavorite }
 *   delete  DELETE /activities/:id
 *
 * The wire still says `customerId` (a company) and `contactId` (a person); the
 * platform also writes `relatedTo` / `relatedToId` / `relatedToName` so its
 * Notes list can name the record, and so do we.
 */

import type { ApiResponse } from '@weldsuite/mobile-ui/types';
import { appApiClient } from './app-api';
import type { Page } from './api';
import { buildNoteHtml, noteSubject, type NoteParts } from '@/lib/note-text';

export type RecordKind = 'company' | 'person';

/** The company or person a note (or activity) is about. */
export interface RecordRef {
  kind: RecordKind;
  id: string;
  name?: string;
}

export interface NoteRecord {
  id: string;
  subject: string;
  /** HTML body as the platform's editor writes it. */
  html: string;
  isFavorite: boolean;
  record?: RecordRef;
  authorId?: string;
  createdAt: string;
  updatedAt: string;
}

interface ActivityRow {
  id: string;
  subject: string;
  description?: string | null;
  isFavorite?: boolean | null;
  customerId?: string | null;
  contactId?: string | null;
  personId?: string | null;
  relatedTo?: string | null;
  relatedToId?: string | null;
  relatedToName?: string | null;
  assignedToId?: string | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ListEnvelope<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

const ok = <T>(data: T): ApiResponse<T> => ({ success: true, data });
const fail = <T>(err: unknown): ApiResponse<T> => ({
  success: false,
  error: err instanceof Error ? err.message : 'Request failed',
});

/** Which record an activity row points at, preferring the typed columns. */
export function recordOfActivity(row: Pick<ActivityRow, 'customerId' | 'contactId' | 'personId' | 'relatedTo' | 'relatedToId' | 'relatedToName'>): RecordRef | undefined {
  const name = row.relatedToName ?? undefined;
  const personId = row.contactId || row.personId;
  if (personId) return { kind: 'person', id: personId, name };
  if (row.customerId) return { kind: 'company', id: row.customerId, name };
  if ((row.relatedTo === 'person' || row.relatedTo === 'contact') && row.relatedToId) {
    return { kind: 'person', id: row.relatedToId, name };
  }
  if ((row.relatedTo === 'company' || row.relatedTo === 'customer') && row.relatedToId) {
    return { kind: 'company', id: row.relatedToId, name };
  }
  return undefined;
}

/** The wire fields that attach an activity to a record, as the platform writes them. */
export function recordLinkPayload(record: RecordRef | undefined): Record<string, string> {
  if (!record) return {};
  const link: Record<string, string> = {
    relatedTo: record.kind,
    relatedToId: record.id,
    ...(record.name ? { relatedToName: record.name } : {}),
  };
  if (record.kind === 'company') link.customerId = record.id;
  else link.contactId = record.id;
  return link;
}

export function mapNote(row: ActivityRow): NoteRecord {
  return {
    id: row.id,
    subject: row.subject,
    html: row.description ?? '',
    isFavorite: !!row.isFavorite,
    record: recordOfActivity(row),
    authorId: row.assignedToId ?? row.createdBy ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function query(params: Record<string, string | number | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') qs.append(key, String(value));
  }
  return qs.toString();
}

export const notesApi = {
  async list(params: {
    cursor?: string | null;
    search?: string;
    record?: Pick<RecordRef, 'kind' | 'id'>;
    limit?: number;
  }): Promise<ApiResponse<Page<NoteRecord>>> {
    try {
      const res = await appApiClient.get<ListEnvelope<ActivityRow>>(
        `/activities?${query({
          type: 'note',
          limit: params.limit ?? 50,
          cursor: params.cursor,
          search: params.search?.trim(),
          customerId: params.record?.kind === 'company' ? params.record.id : undefined,
          contactId: params.record?.kind === 'person' ? params.record.id : undefined,
        })}`,
      );
      return ok({
        items: res.data.map(mapNote),
        totalCount: res.pagination.totalCount,
        hasMore: res.pagination.hasMore,
        cursor: res.pagination.cursor,
      });
    } catch (err) {
      return fail(err);
    }
  },

  async get(id: string): Promise<ApiResponse<NoteRecord>> {
    try {
      const res = await appApiClient.get<{ data: ActivityRow }>(`/activities/${id}`);
      return ok(mapNote(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  async create(parts: NoteParts, record?: RecordRef): Promise<ApiResponse<{ id: string }>> {
    try {
      const res = await appApiClient.post<{ data: { id: string } }>('/activities', {
        type: 'note',
        subject: noteSubject(parts),
        description: buildNoteHtml(parts),
        ...recordLinkPayload(record),
      });
      return ok({ id: res.data.id });
    } catch (err) {
      return fail(err);
    }
  },

  async update(id: string, parts: NoteParts): Promise<ApiResponse<null>> {
    try {
      await appApiClient.patch(`/activities/${id}`, {
        subject: noteSubject(parts),
        description: buildNoteHtml(parts),
      });
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },

  async setFavorite(id: string, isFavorite: boolean): Promise<ApiResponse<null>> {
    try {
      await appApiClient.patch(`/activities/${id}`, { isFavorite });
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },

  async remove(id: string): Promise<ApiResponse<null>> {
    try {
      await appApiClient.delete(`/activities/${id}`);
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },
};
