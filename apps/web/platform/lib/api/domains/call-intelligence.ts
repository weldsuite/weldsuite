/**
 * Call Intelligence Domain Types
 *
 * Shared VoIP types for the WeldCall surfaces and the phone-number settings.
 *
 * The `callIntelligenceWorkerApi` client that used to live here is gone. It
 * talked to the obsolete api-worker on `/crm/call-intelligence/*` via the
 * legacy worker client, but it was never exported — nothing could reach it, so
 * all fourteen of its calls were dead, as was `consumeVoipCallCredits` (the sole
 * consumer of the equally-unreachable `domains/credits.ts`, now deleted).
 *
 * The live surface is on app-api `/api/call-intelligence/*` + `/api/calls` via
 * `useAppApiClient()`: see `@/hooks/queries/use-voip-calls-queries`,
 * `use-call-intelligence-queries`, and `@/hooks/use-phone-numbers`. Those hooks
 * import the types below and nothing else from this module.
 */

// ============================================================================
// Types
// ============================================================================

type VoipProvider = 'telnyx';

export interface VoipCall {
  id: string;
  workspaceId: string;
  userId: string;
  provider: VoipProvider;
  providerCallId?: string;
  providerSessionId?: string;
  providerLegId?: string;
  direction: 'inbound' | 'outbound';
  status: string;
  fromNumber: string;
  toNumber: string;
  fromNumberFormatted?: string;
  toNumberFormatted?: string;
  initiatedAt: string;
  answeredAt?: string;
  endedAt?: string;
  duration?: number;
  isRecorded?: boolean;
  recordingStorageKey?: string;
  recordingStorageUrl?: string;
  recordingFileSize?: number;
  recordingDuration?: number;
  recordingSid?: string;
  transcriptionId?: string;
  transcriptionStatus?: string;
  customerId?: string;
  contactId?: string;
  opportunityId?: string;
  activityId?: string;
  creditsConsumed?: number;
  creditTransactionId?: string;
  aiSummary?: string;
  aiSentiment?: string;
  aiKeyTopics?: string[];
  aiActionItems?: string[];
  aiAnalyzedAt?: string;
  hangupCause?: string;
  hangupSource?: string;
  errorMessage?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VoipPhoneNumber {
  id: string;
  provider: VoipProvider;
  phoneNumber: string;
  formattedNumber?: string;
  countryCode: string;
  numberType?: string;
  providerPhoneNumberId?: string;
  providerConnectionId?: string;
  status: string;
  workspaceId?: string;
  assignedUserId?: string;
  assignedAt?: string;
  isDefault?: boolean;
  allowInbound?: boolean;
  allowOutbound?: boolean;
  enableRecording?: boolean;
  displayName?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CallFilters {
  page?: number;
  pageSize?: number;
  limit?: number;
  status?: string;
  direction?: 'inbound' | 'outbound';
  customerId?: string;
  contactId?: string;
  userId?: string;
  search?: string;
  from?: string;
  to?: string;
  provider?: VoipProvider;
}

export interface CallStats {
  totalCalls: number;
  completedCalls: number;
  totalDuration: number;
  avgDuration: number;
  inboundCalls: number;
  outboundCalls: number;
  recordedCalls: number;
  totalCreditsConsumed: number;
}

interface PaginationMeta {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasMore: boolean;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: PaginationMeta;
}

export interface SingleResponse<T> {
  success: boolean;
  data: T;
}
