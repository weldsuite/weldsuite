import { z } from 'zod';

// ============================================================================
// WeldCall (call-api) response shapes, matching what the platform reads
// (`VoipCall`, `VoipPhoneNumber`, `CallStats` in
// apps/web/platform/lib/api/domains/call-intelligence.ts, and the phone
// number and porting hooks). The conformance suite validates both backends'
// answers against them. Zod v3.
// ============================================================================

const timestamp = z.string();
const nullableText = z.string().nullable();

/** `{ id }`: what the create and update routes answer. */
export const callIdRefSchema = z.object({ id: z.string() });

/** `{ success: true }`. */
export const callSuccessSchema = z.object({ success: z.literal(true) });

/** A `voip_calls` row. */
export const voipCallSchema = z.object({
  id: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  userId: z.string(),
  provider: z.string(),
  providerCallId: nullableText,
  providerSessionId: nullableText,
  providerLegId: nullableText,
  direction: z.string(),
  status: z.string(),
  fromNumber: z.string(),
  toNumber: z.string(),
  fromNumberFormatted: nullableText,
  toNumberFormatted: nullableText,
  initiatedAt: timestamp,
  answeredAt: timestamp.nullable(),
  endedAt: timestamp.nullable(),
  duration: z.number().int().nullable(),
  isRecorded: z.boolean().nullable(),
  recordingStorageKey: nullableText,
  recordingStorageUrl: nullableText,
  recordingFileSize: z.number().int().nullable(),
  recordingDuration: z.number().int().nullable(),
  recordingSid: nullableText,
  transcriptionId: nullableText,
  transcriptionStatus: nullableText,
  customerId: nullableText,
  contactId: nullableText,
  opportunityId: nullableText,
  activityId: nullableText,
  deskConversationId: nullableText,
  creditsConsumed: z.number().int().nullable(),
  creditTransactionId: nullableText,
  aiSummary: nullableText,
  aiSentiment: nullableText,
  aiKeyTopics: z.array(z.string()).nullable(),
  aiActionItems: z.array(z.string()).nullable(),
  aiAnalyzedAt: timestamp.nullable(),
  hangupCause: nullableText,
  hangupSource: nullableText,
  errorMessage: nullableText,
  callQualityScore: nullableText,
  notes: nullableText,
});

/** `PUT /api/calls/:id`: the id with the fields that were sent. */
export const voipCallUpdatedSchema = z
  .object({ id: z.string() })
  .catchall(z.unknown());

/** A `voip_phone_numbers` row. */
export const voipPhoneNumberSchema = z.object({
  id: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  provider: z.string(),
  phoneNumber: z.string(),
  formattedNumber: nullableText,
  countryCode: z.string(),
  numberType: nullableText,
  providerPhoneNumberId: nullableText,
  providerConnectionId: nullableText,
  status: z.string(),
  assignedUserId: nullableText,
  assignedAt: timestamp.nullable(),
  isDefault: z.boolean().nullable(),
  allowInbound: z.boolean().nullable(),
  allowOutbound: z.boolean().nullable(),
  enableRecording: z.boolean().nullable(),
  displayName: nullableText,
  description: nullableText,
  deletedAt: timestamp.nullable(),
});

/** `POST /api/call-intelligence/token`. */
export const callTokenSchema = z.object({
  token: z.string().nullable(),
  message: z.string().optional(),
  configured: z.boolean(),
  provider: z.literal('telnyx'),
});

/** `GET /api/call-intelligence/stats`. */
export const callStatsSchema = z.object({
  totalCalls: z.number().int(),
  completedCalls: z.number().int(),
  totalDuration: z.number().int(),
  avgDuration: z.number().int(),
  inboundCalls: z.number().int(),
  outboundCalls: z.number().int(),
  recordedCalls: z.number().int(),
  totalCreditsConsumed: z.number().int(),
});

const transcriptSegmentSchema = z
  .object({
    id: z.string(),
    transcriptionId: z.string(),
    speakerId: z.number().int(),
    speakerLabel: nullableText,
    text: z.string(),
    startTime: z.number(),
    endTime: z.number(),
    sequenceNumber: z.number().int(),
    start: z.number(),
    end: z.number(),
    speaker: nullableText,
  })
  .passthrough();

/** A call's transcription with its segments. */
export const callTranscriptionSchema = z
  .object({
    id: z.string(),
    activityId: z.string(),
    status: z.string(),
    fullText: nullableText,
    language: nullableText,
    segments: z.array(transcriptSegmentSchema),
  })
  .passthrough();

/** A call transcription's progress. */
export const callTranscriptionStatusSchema = z.union([
  z.object({ exists: z.literal(false) }),
  z.object({
    exists: z.literal(true),
    id: z.string(),
    status: z.string(),
    errorMessage: nullableText,
    processingStartedAt: timestamp.nullable(),
    processingCompletedAt: timestamp.nullable(),
    wordCount: z.number().int().nullable(),
    speakerCount: z.number().int().nullable(),
  }),
]);

/** A WeldDesk phone route (`toRouteJson`). */
export const deskPhoneRouteSchema = z.object({
  id: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  voipPhoneNumberId: z.string(),
  action: z.enum(['ai_agent', 'forward', 'hangup']),
  voiceAgentId: nullableText,
  forwardToE164: nullableText,
  schedule: z.record(z.unknown()).nullable(),
});

/** `{ ok: true }`. */
export const okSchema = z.object({ ok: z.literal(true) });

/** `GET /api/telephony/configured`. */
export const telephonyConfiguredSchema = z.object({ configured: z.boolean() });

const costSchema = z.object({ currency: z.unknown(), monthly_cost: z.string(), upfront_cost: z.string() });

/** One available Telnyx number, in the purchase UI's shape. */
export const availableNumberSchema = z
  .object({
    phone_number: z.string(),
    friendly_name: z.string(),
    iso_country: z.string(),
    locality: z.string().optional(),
    region: z.string().optional(),
    region_information: z.array(z.unknown()),
    cost_information: costSchema.optional(),
    features: z.array(z.object({ name: z.string() })),
    capabilities: z.object({ voice: z.boolean(), sms: z.boolean(), mms: z.boolean() }),
  })
  .passthrough();

export const telephonySearchSchema = z.object({ numbers: z.array(availableNumberSchema) });

/** `POST /api/telephony/phone-numbers/provision`: the Stripe Checkout to go through. */
export const telephonyCheckoutSchema = z.object({ requiresCheckout: z.literal(true), checkoutUrl: z.string() });

export const telephonySyncSchema = z.object({ count: z.number().int() });

export const telephonyAddressesSchema = z.object({ addresses: z.array(z.unknown()) });
export const telephonyAddressSchema = z.object({ address: z.unknown().optional() });
export const telephonyBundlesSchema = z.object({ bundles: z.array(z.unknown()) });

/** A regulatory requirement of ordering a number. */
export const orderingRequirementSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  fieldType: z.enum(['textual', 'address', 'document', 'action', 'datetime']),
  example: z.string().optional(),
  fieldValue: z.unknown().optional(),
  status: z.unknown().optional(),
});

export const telephonyRequirementsSchema = z.object({ requirements: z.array(orderingRequirementSchema) });

/** What a number's Telnyx order still owes. */
export const orderRequirementsSchema = z.object({
  orderId: z.unknown().optional(),
  phoneNumberOrderId: z.unknown().optional(),
  requirementsMet: z.boolean(),
  requirements: z.array(orderingRequirementSchema),
});

export const requirementsSubmittedSchema = z.object({ requirementsMet: z.boolean() });
export const telnyxDocumentSchema = z.object({ id: z.unknown(), filename: z.unknown() });

export const telephonyPricingSchema = z.object({
  pricing: z.array(
    z.object({
      countryCode: z.string(),
      numberType: z.string(),
      monthlyPrice: z.number(),
      setupFee: z.number(),
      currency: z.string(),
      stripePriceId: z.string().optional(),
    }),
  ),
});

export const telephonyServiceRatesSchema = z.object({
  rates: z.object({ voipCallMinute: z.number(), callTranscriptionMinute: z.number() }),
});

export const addressRequiredSchema = z.object({ required: z.boolean(), countryCode: z.string() });

/** A `voip_porting_orders` row. */
export const portingOrderSchema = z.object({
  id: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  createdByUserId: z.string(),
  phoneNumber: z.string(),
  formattedNumber: nullableText,
  countryCode: z.string(),
  numberType: z.string(),
  telnyxPortingOrderId: nullableText,
  status: z.string(),
  substatus: nullableText,
  requestedFocAt: timestamp.nullable(),
  actualFocAt: timestamp.nullable(),
  authorizedName: nullableText,
  businessName: nullableText,
  serviceAddress: z.record(z.unknown()).nullable(),
  currentCarrier: nullableText,
  currentAccountNumber: nullableText,
  currentPin: nullableText,
  loaStorageKey: nullableText,
  billCopyStorageKey: nullableText,
  stripePriceId: nullableText,
  billingActivated: z.boolean(),
  billingError: nullableText,
  lastErrorCode: nullableText,
  lastErrorMessage: nullableText,
  voipPhoneNumberId: nullableText,
  deletedAt: timestamp.nullable(),
});

export const portingOrderRefSchema = z.object({ order: portingOrderSchema });
export const portingOrdersSchema = z.object({ orders: z.array(portingOrderSchema) });

export const portingPreflightSchema = z.object({
  portable: z.boolean(),
  reasons: z.array(z.string()),
  raw: z.unknown().optional(),
});

export const portingDocumentSchema = z.object({ storageKey: z.string() });

/** `POST /public/webhooks/telnyx/tools/lookup_crm`: what the voice agent reads. */
export const crmLookupResultSchema = z.object({
  matched: z.number().int(),
  results: z.array(
    z.object({
      type: z.enum(['contact', 'customer', 'lead']),
      id: z.string(),
      name: z.string(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      company: z.string().nullable(),
    }),
  ),
  message: z.string().optional(),
});

export const telnyxWebhookHealthSchema = z.object({ status: z.literal('ok'), service: z.literal('telnyx-webhook') });
