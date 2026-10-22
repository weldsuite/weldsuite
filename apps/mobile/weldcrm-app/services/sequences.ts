/**
 * WeldCRM sequences: email drip campaigns that enroll people.
 *
 *   sequences     GET /sequences, GET /sequences/:id
 *   enrollments   GET /sequences/:id/enrollments, POST /sequences/:id/enroll { personIds },
 *                 PATCH /sequences/:id/enrollments/:enrollmentId/(pause|resume),
 *                 DELETE /sequences/enrollments/:enrollmentId (unenroll)
 *   run state     POST /sequences/:id/(launch|pause|resume)
 *
 * Steps are edited on the web only; the app reads the step count and runs the
 * sequence. Same conventions as `services/api.ts`: every method catches the
 * thrown error and returns `{ success, data }` / `{ success: false, error }`.
 */

import type { ApiResponse } from '@weldsuite/mobile-ui/types';
import { appApiClient } from './app-api';
import type { Page } from './api';
import { resolveName } from '@/lib/crm';

// ============================================================================
// Public types
// ============================================================================

/** Sequence statuses the app has a label and actions for; anything else is shown as-is. */
export const SEQUENCE_STATUSES = ['draft', 'active', 'paused'] as const;

export interface CrmSequence {
  id: string;
  name: string;
  description?: string;
  /** 'draft', 'active', 'paused' or whatever else the workflow row holds. */
  status: string;
  stepCount: number;
  /** Everyone enrolled, unenrolled people left out. */
  enrolledCount: number;
  activeCount: number;
  pendingCount: number;
  /** Only on the detail endpoint. */
  completedCount?: number;
  failedCount?: number;
  /** ISO timestamp of the last run, when it ever ran. */
  lastRunAt?: string;
  createdAt: string;
}

/** Enrollment statuses: pending, active, paused, completed, failed, unenrolled. */
export interface SequenceEnrollment {
  id: string;
  sequenceId: string;
  /** The enrolled person's id. */
  personId: string;
  name: string;
  email?: string;
  companyName?: string;
  status: string;
  /** Zero based index of the step the person is at. */
  currentStepIndex: number;
  totalSteps: number;
  enrolledAt: string;
  errorMessage?: string;
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

export interface SequenceWireRow {
  id: string;
  name: string;
  description?: string | null;
  status: string;
  steps?: unknown;
  lastExecutedAt?: string | null;
  createdAt: string;
  enrolledCount?: number | null;
  activeEnrolledCount?: number | null;
  pendingEnrolledCount?: number | null;
  completedEnrolledCount?: number | null;
  failedEnrolledCount?: number | null;
}

export interface EnrollmentWireRow {
  id: string;
  sequenceId: string;
  customerId: string;
  status: string;
  currentStepIndex?: number | null;
  totalSteps?: number | null;
  enrolledAt: string;
  errorMessage?: string | null;
  customerEmail?: string | null;
  customerFirstName?: string | null;
  customerLastName?: string | null;
  customerFullName?: string | null;
  customerCompanyName?: string | null;
}

// ============================================================================
// Mappers and payloads
// ============================================================================

export function mapSequence(row: SequenceWireRow): CrmSequence {
  return {
    id: row.id,
    name: row.name,
    description: row.description?.trim() || undefined,
    status: row.status,
    stepCount: Array.isArray(row.steps) ? row.steps.length : 0,
    enrolledCount: row.enrolledCount ?? 0,
    activeCount: row.activeEnrolledCount ?? 0,
    pendingCount: row.pendingEnrolledCount ?? 0,
    completedCount: row.completedEnrolledCount ?? undefined,
    failedCount: row.failedEnrolledCount ?? undefined,
    lastRunAt: row.lastExecutedAt ?? undefined,
    createdAt: row.createdAt,
  };
}

export function mapEnrollment(row: EnrollmentWireRow): SequenceEnrollment {
  return {
    id: row.id,
    sequenceId: row.sequenceId,
    personId: row.customerId,
    name: resolveName({
      fullName: row.customerFullName,
      firstName: row.customerFirstName,
      lastName: row.customerLastName,
      email: row.customerEmail,
    }),
    email: row.customerEmail?.trim() || undefined,
    companyName: row.customerCompanyName?.trim() || undefined,
    status: row.status,
    currentStepIndex: row.currentStepIndex ?? 0,
    totalSteps: row.totalSteps ?? 0,
    enrolledAt: row.enrolledAt,
    errorMessage: row.errorMessage?.trim() || undefined,
  };
}

/** Body of `POST /sequences/:id/enroll`. */
export function enrollPayload(personIds: readonly string[]) {
  return { personIds: Array.from(new Set(personIds)) };
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

export const sequencesApi = {
  async getSequences(params?: {
    cursor?: string | null;
    limit?: number;
    search?: string;
  }): Promise<ApiResponse<Page<CrmSequence>>> {
    try {
      const res = await appApiClient.get<ListEnvelope<SequenceWireRow>>(
        `/sequences${query({
          limit: params?.limit ?? 25,
          cursor: params?.cursor,
          search: params?.search?.trim(),
        })}`,
      );
      return ok({
        items: res.data.map(mapSequence),
        totalCount: res.pagination.totalCount,
        hasMore: res.pagination.hasMore,
        cursor: res.pagination.cursor,
      });
    } catch (err) {
      return fail(err);
    }
  },

  async getSequence(id: string): Promise<ApiResponse<CrmSequence>> {
    try {
      const res = await appApiClient.get<DataEnvelope<SequenceWireRow>>(`/sequences/${id}`);
      return ok(mapSequence(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  async getEnrollments(
    id: string,
    params?: { cursor?: string | null; limit?: number; search?: string; status?: string },
  ): Promise<ApiResponse<Page<SequenceEnrollment>>> {
    try {
      const res = await appApiClient.get<ListEnvelope<EnrollmentWireRow>>(
        `/sequences/${id}/enrollments${query({
          limit: params?.limit ?? 25,
          cursor: params?.cursor,
          search: params?.search?.trim(),
          status: params?.status,
        })}`,
      );
      return ok({
        items: res.data.map(mapEnrollment),
        totalCount: res.pagination.totalCount,
        hasMore: res.pagination.hasMore,
        cursor: res.pagination.cursor,
      });
    } catch (err) {
      return fail(err);
    }
  },

  /**
   * Activates a draft sequence. The server refuses (400) a sequence without
   * steps or without enrolled people, and the message says which.
   */
  async launch(id: string): Promise<ApiResponse<null>> {
    try {
      await appApiClient.post(`/sequences/${id}/launch`, {});
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },

  async pause(id: string): Promise<ApiResponse<null>> {
    try {
      await appApiClient.post(`/sequences/${id}/pause`, {});
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },

  async resume(id: string): Promise<ApiResponse<null>> {
    try {
      await appApiClient.post(`/sequences/${id}/resume`, {});
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },

  /** `enrolled` is 0 when the person was already enrolled. */
  async enrollPerson(id: string, personId: string): Promise<ApiResponse<{ enrolled: number }>> {
    try {
      const res = await appApiClient.post<DataEnvelope<{ enrolled: number }>>(
        `/sequences/${id}/enroll`,
        enrollPayload([personId]),
      );
      return ok({ enrolled: res.data.enrolled });
    } catch (err) {
      return fail(err);
    }
  },

  /** Only an active enrollment can be paused. */
  async pauseEnrollment(sequenceId: string, enrollmentId: string): Promise<ApiResponse<null>> {
    try {
      await appApiClient.patch(`/sequences/${sequenceId}/enrollments/${enrollmentId}/pause`, {});
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },

  /** Only a paused enrollment can be resumed, and not while its sequence is paused. */
  async resumeEnrollment(sequenceId: string, enrollmentId: string): Promise<ApiResponse<null>> {
    try {
      await appApiClient.patch(`/sequences/${sequenceId}/enrollments/${enrollmentId}/resume`, {});
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },

  async unenroll(enrollmentId: string): Promise<ApiResponse<null>> {
    try {
      await appApiClient.delete(`/sequences/enrollments/${enrollmentId}`);
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },
};
