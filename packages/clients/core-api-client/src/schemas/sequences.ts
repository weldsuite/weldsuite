import { z } from 'zod';

// ============================================================================
// Sequences — `/api/sequences`.
//
// A "sequence" is a workflow row (`workflows` table) tagged `__type:sequence`.
// Sequence CRUD itself goes through workflow APIs; this route exposes the
// sequence view and manages enrollments via `sequence_enrollments`.
//
// Workflow trigger actions (enroll into a running sequence, launch a draft,
// pause/resume) require the EXECUTE_SEQUENCE Cloudflare Workflow binding
// and are intentionally out of scope for the initial app-api port. The
// frontend will hit those via the legacy api-worker until the binding is
// added to apps/workers/app-api/wrangler.toml.
// ============================================================================

export const listSequencesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  search: z.string().optional(),
});

export const listSequenceEnrollmentsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  status: z.string().optional(),
  search: z.string().optional(),
});

export const unenrollFromSequenceSchema = z.object({
  reason: z.string().max(500).optional(),
});

export type ListSequencesQuery = z.infer<typeof listSequencesQuery>;
export type ListSequenceEnrollmentsQuery = z.infer<typeof listSequenceEnrollmentsQuery>;
export type UnenrollFromSequenceInput = z.infer<typeof unenrollFromSequenceSchema>;

export interface SequenceRow {
  id: string;
  name: string;
  description?: string | null;
  status: string;
  steps?: unknown;
  tags?: unknown;
  executionCount?: number;
  successCount?: number;
  lastExecutedAt?: string | null;
  enrolledCount: number;
  activeEnrolledCount: number;
  pendingEnrolledCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SequenceEnrollmentRow {
  id: string;
  sequenceId: string;
  customerId: string;
  status: string;
  executionId?: string | null;
  currentStepIndex: number;
  totalSteps: number;
  enrolledBy?: string | null;
  enrolledAt: string;
  completedAt?: string | null;
  pausedAt?: string | null;
  unenrolledAt?: string | null;
  failedAt?: string | null;
  errorMessage?: string | null;
  customerSnapshot?: unknown;
}

// ── Responses (checked against both backends in conformance) ────────────────

/** A sequence in `GET /api/sequences` (`SequenceRow`). */
export const sequenceRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  status: z.string(),
  steps: z.unknown(),
  tags: z.unknown(),
  executionCount: z.number().nullish(),
  successCount: z.number().nullish(),
  lastExecutedAt: z.string().nullish(),
  enrolledCount: z.number(),
  activeEnrolledCount: z.number(),
  pendingEnrolledCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** `GET /api/sequences/:id`. */
export const sequenceDetailSchema = sequenceRowSchema.extend({
  triggers: z.unknown(),
  settings: z.unknown(),
  failureCount: z.number().nullish(),
  completedEnrolledCount: z.number(),
  failedEnrolledCount: z.number(),
});

/** An enrollment in `GET /api/sequences/:id/enrollments` (`SequenceEnrollmentRow`). */
export const sequenceEnrollmentRowSchema = z.object({
  id: z.string(),
  sequenceId: z.string(),
  customerId: z.string(),
  status: z.string(),
  executionId: z.string().nullish(),
  currentStepIndex: z.number().nullish(),
  totalSteps: z.number(),
  enrolledBy: z.string().nullish(),
  enrolledAt: z.string(),
  completedAt: z.string().nullish(),
  pausedAt: z.string().nullish(),
  unenrolledAt: z.string().nullish(),
  failedAt: z.string().nullish(),
  errorMessage: z.string().nullish(),
  customerSnapshot: z.unknown(),
  customerEmail: z.string().nullable(),
  customerFirstName: z.string().nullable(),
  customerLastName: z.string().nullable(),
  customerFullName: z.string().nullable(),
  customerCompanyName: z.string().nullable(),
});

/** `POST /api/sequences/:id/enroll`. */
export const sequenceEnrollResultSchema = z.object({
  enrolled: z.number(),
  enrollmentIds: z.array(z.string()),
});

/** `POST /api/sequences/:id/launch`, `/start`, `/resume`, `/pause` and the enrollment pause/resume. */
export const sequenceActionResultSchema = z
  .object({
    activated: z.number(),
    triggered: z.number(),
    resumed: z.boolean(),
    resumedEnrollments: z.number(),
    paused: z.boolean(),
    pausedEnrollments: z.number(),
  })
  .partial();

/** A row of `GET /api/customer-sequences/:customerId`. */
export const customerSequenceRowSchema = z.object({
  enrollmentId: z.string(),
  sequenceId: z.string(),
  status: z.string(),
  currentStepIndex: z.number().nullable(),
  totalSteps: z.number().nullable(),
  enrolledAt: z.string(),
  completedAt: z.string().nullable(),
  sequenceName: z.string(),
  sequenceStatus: z.string(),
});
