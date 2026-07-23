import { z } from 'zod';

// ============================================================================
// Access Requests — the "Request access" flow when a user lacks permission
// to a page. Backed by the `access_requests` table; admins are notified via
// the shared `notifications` table + realtime fan-out.
// ============================================================================

export const createAccessRequestSchema = z.object({
  permission: z.string().min(1).max(100),
  pageLabel: z.string().max(120).optional(),
  pagePath: z.string().max(255).optional(),
});

export type CreateAccessRequestInput = z.infer<typeof createAccessRequestSchema>;

export const resolveAccessRequestSchema = z.object({
  status: z.enum(['approved', 'denied']),
});

export type ResolveAccessRequestInput = z.infer<typeof resolveAccessRequestSchema>;

export interface AccessRequest {
  id: string;
  requesterId: string;
  permission: string;
  pageLabel: string | null;
  pagePath: string | null;
  status: 'pending' | 'approved' | 'denied';
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
