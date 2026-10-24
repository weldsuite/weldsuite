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
