/**
 * WeldSign — the contract between sign-api and the platform. Zod v3.
 *
 * An envelope is one signing request: PDFs, the people on it and the fields
 * they fill in. Phase 1 (docs/plans/weldsign.md) covers drafts: create, upload
 * documents, add recipients, place fields, list. Sending, the signer portal
 * and templates build on the same shapes.
 *
 * The enums mirror `packages/core/db/src/schema/weldsign.ts`; keep them in step.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const SIGN_ENVELOPE_STATUSES = ['draft', 'sent', 'in_progress', 'completed', 'declined', 'voided', 'expired'] as const;
export type SignEnvelopeStatus = (typeof SIGN_ENVELOPE_STATUSES)[number];

export const SIGN_RECIPIENT_ROLES = ['signer', 'cc'] as const;
export type SignRecipientRole = (typeof SIGN_RECIPIENT_ROLES)[number];

export const SIGN_RECIPIENT_STATUSES = ['pending', 'sent', 'opened', 'signed', 'declined'] as const;
export type SignRecipientStatus = (typeof SIGN_RECIPIENT_STATUSES)[number];

export const SIGN_AUTH_MODES = ['link', 'email_code', 'access_code'] as const;
export type SignAuthMode = (typeof SIGN_AUTH_MODES)[number];

export const SIGN_FIELD_TYPES = ['signature', 'initials', 'date_signed', 'name', 'email', 'text', 'checkbox'] as const;
export type SignFieldType = (typeof SIGN_FIELD_TYPES)[number];

export const SIGN_LOCALES = ['en', 'nl'] as const;
export type SignLocale = (typeof SIGN_LOCALES)[number];

/** List folders on the WeldSign home. */
export const SIGN_ENVELOPE_FOLDERS = ['all', 'drafts', 'in_progress', 'completed', 'closed'] as const;
export type SignEnvelopeFolder = (typeof SIGN_ENVELOPE_FOLDERS)[number];

/** Which statuses each folder shows; `all` shows every status. */
export const SIGN_FOLDER_STATUSES: Record<Exclude<SignEnvelopeFolder, 'all'>, readonly SignEnvelopeStatus[]> = {
  drafts: ['draft'],
  in_progress: ['sent', 'in_progress'],
  completed: ['completed'],
  closed: ['declined', 'voided', 'expired'],
};

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const SIGN_LIMITS = {
  /** PDFs per envelope. */
  maxDocuments: 10,
  /** Bytes per PDF. */
  maxDocumentBytes: 25 * 1024 * 1024,
  /** Pages per PDF. */
  maxPages: 500,
  /** Recipients per envelope. */
  maxRecipients: 50,
  /** Fields per envelope. */
  maxFields: 1000,
} as const;

/** Smallest field box, in PDF points. */
export const SIGN_MIN_FIELD_SIZE = 8;

/** Default box per field type, in PDF points (a page is 595 × 842 for A4). */
export const SIGN_FIELD_DEFAULT_SIZE: Record<SignFieldType, { width: number; height: number }> = {
  signature: { width: 160, height: 48 },
  initials: { width: 64, height: 40 },
  date_signed: { width: 110, height: 22 },
  name: { width: 160, height: 22 },
  email: { width: 180, height: 22 },
  text: { width: 160, height: 22 },
  checkbox: { width: 16, height: 16 },
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const title = z.string().trim().min(1).max(255);
const message = z.string().trim().max(5000);
const days = z.number().int().min(1).max(90);

export const createEnvelopeSchema = z.object({
  title,
  message: message.nullish(),
});
export type CreateSignEnvelopeInput = z.infer<typeof createEnvelopeSchema>;

/** Draft settings. Only a draft can be changed. */
export const updateEnvelopeSchema = z
  .object({
    title,
    message: message.nullable(),
    signingOrderEnabled: z.boolean(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    reminderAfterDays: days.nullable(),
    reminderEveryDays: days.nullable(),
    reminderMaxCount: z.number().int().min(0).max(10).nullable(),
  })
  .partial();
export type UpdateSignEnvelopeInput = z.infer<typeof updateEnvelopeSchema>;

export const listEnvelopesQuerySchema = z.object({
  folder: z.enum(SIGN_ENVELOPE_FOLDERS).optional(),
  search: z.string().trim().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
});
export type ListSignEnvelopesQuery = z.infer<typeof listEnvelopesQuerySchema>;

export const reorderDocumentsSchema = z.object({
  /** Every document id of the envelope, in the new order. */
  documentIds: z.array(z.string().min(1)).min(1).max(SIGN_LIMITS.maxDocuments),
});
export type ReorderSignDocumentsInput = z.infer<typeof reorderDocumentsSchema>;

const recipientBase = z.object({
  role: z.enum(SIGN_RECIPIENT_ROLES),
  name: z.string().trim().min(1).max(255),
  email: z.string().trim().toLowerCase().email().max(320),
  personId: z.string().max(30).nullish(),
  locale: z.enum(SIGN_LOCALES),
  routingOrder: z.number().int().min(1).max(SIGN_LIMITS.maxRecipients),
  authMode: z.enum(SIGN_AUTH_MODES),
  /**
   * Code the sender shares with the signer themselves (auth mode
   * `access_code`). Write-only: it is stored hashed and never returned.
   */
  accessCode: z.string().trim().min(4).max(64).nullish(),
});

export const createRecipientSchema = recipientBase.partial({ locale: true, routingOrder: true, authMode: true, role: true });
export type CreateSignRecipientInput = z.infer<typeof createRecipientSchema>;

export const updateRecipientSchema = recipientBase.partial();
export type UpdateSignRecipientInput = z.infer<typeof updateRecipientSchema>;

export const fieldInputSchema = z.object({
  /** Kept when the field already exists; new fields get an id from the server. */
  id: z.string().max(30).optional(),
  documentId: z.string().min(1).max(30),
  recipientId: z.string().min(1).max(30),
  type: z.enum(SIGN_FIELD_TYPES),
  /** Zero-based page index. */
  page: z.number().int().min(0),
  /** Box in PDF points of the page as displayed, origin top-left. */
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().min(SIGN_MIN_FIELD_SIZE),
  height: z.number().min(SIGN_MIN_FIELD_SIZE),
  required: z.boolean(),
  label: z.string().trim().max(255).nullish(),
});
export type SignFieldInput = z.infer<typeof fieldInputSchema>;

/** The editor saves the whole field set at once. */
export const replaceFieldsSchema = z.object({
  fields: z.array(fieldInputSchema).max(SIGN_LIMITS.maxFields),
});
export type ReplaceSignFieldsInput = z.infer<typeof replaceFieldsSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** Page size in PDF points as displayed (rotation applied), plus the page's /Rotate. */
export interface SignPageSize {
  width: number;
  height: number;
  rotation?: number;
}

export interface SignDocumentDto {
  id: string;
  name: string;
  position: number;
  sizeBytes: number;
  pageCount: number;
  pageSizes: SignPageSize[];
  /** SHA-256 (hex) of the original bytes. */
  sha256: string;
  createdAt: string;
}

export interface SignRecipientDto {
  id: string;
  role: SignRecipientRole;
  name: string | null;
  email: string | null;
  personId: string | null;
  locale: SignLocale;
  routingOrder: number;
  authMode: SignAuthMode;
  /** Whether an access code is set; the code itself is never returned. */
  hasAccessCode: boolean;
  status: SignRecipientStatus;
  sentAt: string | null;
  openedAt: string | null;
  signedAt: string | null;
  declinedAt: string | null;
}

export interface SignFieldDto {
  id: string;
  documentId: string;
  recipientId: string;
  type: SignFieldType;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  label: string | null;
}

export interface SignRecipientCounts {
  signers: number;
  signed: number;
  cc: number;
}

/** One row of the envelope list. */
export interface SignEnvelopeSummary {
  id: string;
  title: string;
  status: SignEnvelopeStatus;
  senderUserId: string;
  senderName: string | null;
  documentCount: number;
  recipients: SignRecipientCounts;
  /** Up to three recipient names (or emails), for the list. */
  recipientPreview: string[];
  sentAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SignEnvelopeDetail extends SignEnvelopeSummary {
  message: string | null;
  signingOrderEnabled: boolean;
  reminderAfterDays: number | null;
  reminderEveryDays: number | null;
  reminderMaxCount: number | null;
  documents: SignDocumentDto[];
  recipients: SignRecipientCounts;
  recipientList: SignRecipientDto[];
  fields: SignFieldDto[];
  /** The caller may change this envelope: it is a draft, they own it (or manage WeldSign) and hold `sign_envelopes:update`. */
  canEdit: boolean;
}

// ---------------------------------------------------------------------------
// Helpers shared by the editor and the server
// ---------------------------------------------------------------------------

/** Field types a signer fills in; copy recipients get no fields. */
export function fieldBelongsToSigner(role: SignRecipientRole): boolean {
  return role === 'signer';
}

/** Whether a field box lies inside its page (PDF points, origin top-left). */
export function fieldFitsPage(field: Pick<SignFieldInput, 'x' | 'y' | 'width' | 'height'>, page: SignPageSize): boolean {
  // Half a point of slack: the editor converts from screen pixels.
  const slack = 0.5;
  return field.x + field.width <= page.width + slack && field.y + field.height <= page.height + slack;
}

// ---------------------------------------------------------------------------
// Sending (members)
// ---------------------------------------------------------------------------

export const sendEnvelopeSchema = z.object({
  /** When the request stops accepting signatures; defaults to the workspace setting (30 days). */
  expiresAt: z.string().datetime({ offset: true }).nullish(),
});
export type SendSignEnvelopeInput = z.infer<typeof sendEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Signer portal (/public/sign-portal/*, called by apps/web/sign-portal)
// ---------------------------------------------------------------------------

/**
 * Version of the e-signature disclosure a signer agrees to. Stored with the
 * `consented` event; bump it whenever the disclosure text changes.
 */
export const SIGN_DISCLOSURE_VERSION = '2026-10-24';

export const portalSessionSchema = z.object({
  /** The token from the signing link (`/r/<token>`). */
  token: z.string().min(20).max(200),
});
export type SignPortalSessionInput = z.infer<typeof portalSessionSchema>;

export const portalVerifySchema = portalSessionSchema.extend({
  code: z.string().trim().min(4).max(64),
});
export type SignPortalVerifyInput = z.infer<typeof portalVerifySchema>;

export const SIGN_PORTAL_CLOSED_REASONS = ['expired', 'voided', 'declined'] as const;
export type SignPortalClosedReason = (typeof SIGN_PORTAL_CLOSED_REASONS)[number];

/**
 * Answer to opening a link (and to a code check):
 * - `ready`: here is a signer session (bearer token for every other route);
 * - `code_required`: ask for the emailed code or the access code first;
 * - `closed`: the request can no longer be opened.
 * An unknown or revoked link is a 404.
 */
export type SignPortalSessionResponse =
  | { state: 'ready'; session: string; expiresAt: string }
  | { state: 'code_required'; method: 'email_code' | 'access_code'; emailHint: string | null }
  | { state: 'closed'; reason: SignPortalClosedReason };

export const portalConsentSchema = z.object({
  disclosureVersion: z.string().min(1).max(40),
});

const pngDataUrl = z
  .string()
  .max(700_000)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, 'Expected a PNG data URL');

export const portalSignatureSchema = z.object({
  /** How the signer made it; recorded on the certificate. */
  kind: z.enum(['drawn', 'typed', 'uploaded']),
  /** The image, already rendered to PNG by the portal. */
  image: pngDataUrl,
});
export type SignPortalSignature = z.infer<typeof portalSignatureSchema>;

export const portalCompleteSchema = z.object({
  /** Values of the signer's text and checkbox fields ('true' / 'false' for a checkbox). */
  values: z.array(z.object({ fieldId: z.string().min(1).max(30), value: z.string().max(1000) })).max(SIGN_LIMITS.maxFields),
  /** Required when the signer has a signature field. */
  signature: portalSignatureSchema.nullish(),
  /** Required when the signer has an initials field. */
  initials: portalSignatureSchema.nullish(),
  /** The signer's IANA time zone, for the date-signed fields. */
  timeZone: z.string().max(64).nullish(),
});
export type SignPortalCompleteInput = z.infer<typeof portalCompleteSchema>;

export const portalDeclineSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});
export type SignPortalDeclineInput = z.infer<typeof portalDeclineSchema>;

export interface SignPortalField {
  id: string;
  documentId: string;
  type: SignFieldType;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  label: string | null;
  /** Set once the signer has signed. */
  value: string | null;
}

export interface SignPortalBrand {
  /** The workspace (or its WeldSign brand name). */
  name: string;
  color: string | null;
  logoUrl: string | null;
}

/** What the signer sees. Only their own fields; earlier signers' values are already in the PDF. */
export interface SignPortalEnvelope {
  envelopeId: string;
  title: string;
  message: string | null;
  status: SignEnvelopeStatus;
  senderName: string | null;
  senderEmail: string | null;
  brand: SignPortalBrand;
  recipient: {
    id: string;
    name: string | null;
    email: string | null;
    role: SignRecipientRole;
    status: SignRecipientStatus;
    locale: SignLocale;
    consented: boolean;
  };
  /**
   * What the page should offer:
   * - `sign`: it is this signer's turn;
   * - `waiting`: they signed (or it is not their turn yet) and others still have to;
   * - `completed`: everyone signed; the signed PDF can be downloaded;
   * - `closed`: expired, voided or declined.
   */
  mode: 'sign' | 'waiting' | 'completed' | 'closed';
  closedReason: SignPortalClosedReason | null;
  expiresAt: string | null;
  disclosureVersion: string;
  documents: Pick<SignDocumentDto, 'id' | 'name' | 'pageCount' | 'pageSizes'>[];
  fields: SignPortalField[];
}
