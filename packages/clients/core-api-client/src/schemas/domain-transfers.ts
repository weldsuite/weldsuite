/**
 * Domain transfer schemas (Zod v3) — powers /api/domain-transfers/*.
 */

import { z } from 'zod';

export const domainTransferTypeEnum = z.enum(['incoming', 'outgoing']);
export const domainTransferStatusEnum = z.enum([
  'pending',
  'pending_approval',
  'approved',
  'rejected',
  'cancelled',
  'in_progress',
  'completed',
  'failed',
]);

export const listDomainTransfersQuery = z.object({
  domainId: z.string().optional(),
  status: domainTransferStatusEnum.optional(),
  type: domainTransferTypeEnum.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const createDomainTransferSchema = z.object({
  domainId: z.string().nullish(),
  domainName: z.string().min(1).max(255),
  type: domainTransferTypeEnum,
  authCode: z.string().max(255).optional(),
  fromRegistrar: z.string().max(255).optional(),
  toRegistrar: z.string().max(255).optional(),
});

export const failDomainTransferSchema = z.object({
  reason: z.string().max(2000).optional(),
});

export type ListDomainTransfersQuery = z.input<typeof listDomainTransfersQuery>;
export type CreateDomainTransferInput = z.infer<typeof createDomainTransferSchema>;
export type FailDomainTransferInput = z.infer<typeof failDomainTransferSchema>;

export interface DomainTransfer {
  id: string;
  domainId: string | null;
  domainName: string;
  type: 'incoming' | 'outgoing';
  status:
    | 'pending'
    | 'pending_approval'
    | 'approved'
    | 'rejected'
    | 'cancelled'
    | 'in_progress'
    | 'completed'
    | 'failed';
  authCode: string | null;
  fromRegistrar: string | null;
  toRegistrar: string | null;
  externalTransferId: string | null;
  requestedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  cancelledAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
  rejectionReason: string | null;
  cancellationReason: string | null;
  failureReason: string | null;
  notificationsSent: string[] | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}
