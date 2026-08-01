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
