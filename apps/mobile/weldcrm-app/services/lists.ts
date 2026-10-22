/**
 * WeldCRM lists: static groups of companies or people.
 *
 *   lists     GET/POST /lists, GET/PATCH/DELETE /lists/:id
 *   members   GET /lists/:id/members (not paginated),
 *             POST /lists/:id/members { entityIds }, DELETE /lists/:id/members/:entityId
 *
 * A list has a fixed `kind` ('company' | 'person') chosen when it is created;
 * its members are rows of the matching table. Same conventions as
 * `services/api.ts`: every method catches the thrown error and returns
 * `{ success, data }` / `{ success: false, error }`.
 */

import type { ApiResponse } from '@weldsuite/mobile-ui/types';
import { appApiClient } from './app-api';
import type { Page } from './api';
import { resolveName } from '@/lib/crm';

// ============================================================================
// Public types
// ============================================================================

export type ListKind = 'company' | 'person';

export interface CrmList {
  id: string;
  name: string;
  kind: ListKind;
  description?: string;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

/** A company or person in a list. `id` is the company or person id. */
export interface ListMember {
  id: string;
  /** Row id of the membership itself. */
  memberId: string;
  kind: ListKind;
  name: string;
  subtitle?: string;
  email?: string;
  addedAt: string;
}

export interface CreateListInput {
  name: string;
  kind: ListKind;
}

// ============================================================================
// Wire shapes (internal)
// ============================================================================

interface ListEnvelope<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

interface DataEnvelope<T> {
  data: T;
}

export interface ListWireRow {
  id: string;
  name: string;
  kind?: string | null;
  description?: string | null;
  memberCount?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemberEntityWire {
  id?: string;
  displayName?: string | null;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  email?: string | null;
  /** A person's job title. */
  title?: string | null;
  /** A company's industry. */
  industry?: string | null;
}

export interface MemberWireRow {
  memberId: string;
  entityId: string;
  addedAt: string;
  entity: MemberEntityWire;
}

// ============================================================================
// Mappers and payloads
// ============================================================================

export function mapList(row: ListWireRow): CrmList {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === 'person' ? 'person' : 'company',
    description: row.description?.trim() || undefined,
    memberCount: row.memberCount ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapListMember(kind: ListKind, row: MemberWireRow): ListMember {
  const entity = row.entity;
  const detail = kind === 'person' ? entity.title : entity.industry;
  return {
    id: row.entityId,
    memberId: row.memberId,
    kind,
    name: resolveName(entity),
    subtitle: detail?.trim() || entity.email?.trim() || undefined,
    email: entity.email?.trim() || undefined,
    addedAt: row.addedAt,
  };
}

/** Body of `POST /lists`: static lists only, colour and icon take the server defaults. */
export function createListPayload(input: CreateListInput) {
  return { name: input.name.trim(), kind: input.kind, type: 'static' as const };
}

export function renameListPayload(name: string) {
  return { name: name.trim() };
}

export function addMembersPayload(entityIds: readonly string[]) {
  return { entityIds: Array.from(new Set(entityIds)) };
}

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function fail<T>(err: unknown): ApiResponse<T> {
  return { success: false, error: err instanceof Error ? err.message : 'Request failed' };
}

/** Build `?a=1&b=2`, leaving out empty values. */
function query(params: Record<string, string | number | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') qs.append(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

// ============================================================================
// API client
// ============================================================================

export const listsApi = {
  async getLists(params?: {
    cursor?: string | null;
    limit?: number;
    search?: string;
    kind?: ListKind;
  }): Promise<ApiResponse<Page<CrmList>>> {
    try {
      const res = await appApiClient.get<ListEnvelope<ListWireRow>>(
        `/lists${query({
          limit: params?.limit ?? 50,
          cursor: params?.cursor,
          search: params?.search?.trim(),
          kind: params?.kind,
        })}`,
      );
      return ok({
        items: res.data.map(mapList),
        totalCount: res.pagination.totalCount,
        hasMore: res.pagination.hasMore,
        cursor: res.pagination.cursor,
      });
    } catch (err) {
      return fail(err);
    }
  },

  async getList(id: string): Promise<ApiResponse<CrmList>> {
    try {
      const res = await appApiClient.get<DataEnvelope<ListWireRow>>(`/lists/${id}`);
      return ok(mapList(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  async createList(input: CreateListInput): Promise<ApiResponse<CrmList>> {
    try {
      const res = await appApiClient.post<DataEnvelope<ListWireRow>>('/lists', createListPayload(input));
      return ok(mapList(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  async renameList(id: string, name: string): Promise<ApiResponse<CrmList>> {
    try {
      const res = await appApiClient.patch<DataEnvelope<ListWireRow>>(`/lists/${id}`, renameListPayload(name));
      return ok(mapList(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  async deleteList(id: string): Promise<ApiResponse<null>> {
    try {
      await appApiClient.delete(`/lists/${id}`);
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },

  /** Every member of a list, newest first (the endpoint is not paginated). */
  async getMembers(id: string, kind: ListKind): Promise<ApiResponse<ListMember[]>> {
    try {
      const res = await appApiClient.get<DataEnvelope<MemberWireRow[]>>(`/lists/${id}/members`);
      return ok(res.data.map((row) => mapListMember(kind, row)));
    } catch (err) {
      return fail(err);
    }
  },

  /** Adds records; ones already in the list are skipped, so `added` can be 0. */
  async addMembers(id: string, entityIds: readonly string[]): Promise<ApiResponse<{ added: number }>> {
    try {
      const res = await appApiClient.post<DataEnvelope<{ id: string; added: number }>>(
        `/lists/${id}/members`,
        addMembersPayload(entityIds),
      );
      return ok({ added: res.data.added });
    } catch (err) {
      return fail(err);
    }
  },

  async removeMember(id: string, entityId: string): Promise<ApiResponse<null>> {
    try {
      await appApiClient.delete(`/lists/${id}/members/${entityId}`);
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },
};
