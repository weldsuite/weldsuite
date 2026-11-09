/**
 * WeldForms — the contract between forms-api (and its Rust twin), the
 * platform and forms-portal. Zod v3.
 *
 * Member routes live under `/api/forms/*` (Clerk); the respondent routes under
 * `/public/forms/*`, called only by forms-portal with `X-Forms-Portal-Key`
 * (ADR FORMS-002). The definition itself (blocks, logic, themes, answers) is
 * `@weldsuite/forms-engine`'s schema. The enums mirror
 * `packages/core/db/src/schema/weldforms.ts`; keep them in step.
 * See docs/plans/weldforms.md.
 */

import { z } from 'zod';
import {
  blockSchema,
  fileAnswerItemSchema,
  formDefinitionSchema,
  formThemeTokensSchema,
  FORM_LANGUAGES,
  FORM_LAYOUTS,
  type Answers,
  type FormDefinition,
  type FormThemeTokens,
} from '@weldsuite/forms-engine/definition';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const FORM_STATUSES = ['draft', 'published', 'closed'] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];

export const FORM_ACCESS_LEVELS = ['workspace', 'restricted'] as const;
export type FormAccessLevel = (typeof FORM_ACCESS_LEVELS)[number];

export const FORM_ACCESS_ROLES = ['editor', 'results'] as const;
export type FormAccessRole = (typeof FORM_ACCESS_ROLES)[number];

export const FORM_RESPONDENT_MODES = ['anyone', 'verified_email', 'members'] as const;
export type FormRespondentMode = (typeof FORM_RESPONDENT_MODES)[number];

export const FORM_RESPONSE_STATUSES = ['in_progress', 'completed'] as const;
export type FormResponseStatus = (typeof FORM_RESPONSE_STATUSES)[number];

export const FORM_INVITATION_STATUSES = ['sent', 'opened', 'started', 'completed', 'revoked'] as const;
export type FormInvitationStatus = (typeof FORM_INVITATION_STATUSES)[number];

export const FORM_INTEGRATION_KINDS = ['crm', 'desk', 'flow'] as const;
export type FormIntegrationKind = (typeof FORM_INTEGRATION_KINDS)[number];

export const FORM_ACTION_STATUSES = ['pending', 'done', 'failed', 'skipped'] as const;
export type FormActionStatus = (typeof FORM_ACTION_STATUSES)[number];

export const FORM_SUBSCRIPTION_MODES = ['instant', 'daily', 'off'] as const;
export type FormSubscriptionMode = (typeof FORM_SUBSCRIPTION_MODES)[number];

export const FORM_LOCALES = FORM_LANGUAGES;
export type FormLocale = (typeof FORM_LOCALES)[number];

/** What a respondent opening the public link meets. */
export const PUBLIC_FORM_STATES = [
  'open',
  /** A draft, or closed by hand. */
  'closed',
  'not_open_yet',
  'past_close_date',
  'limit_reached',
  /** The workspace used its monthly response quota. */
  'over_quota',
  /** Staff stopped it after an abuse report. */
  'suspended',
  /** The publish content screen holds it for staff review. */
  'held',
] as const;
export type PublicFormState = (typeof PUBLIC_FORM_STATES)[number];

export const FORM_ABUSE_REASONS = ['phishing', 'spam', 'illegal', 'other'] as const;
export type FormAbuseReason = (typeof FORM_ABUSE_REASONS)[number];

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const FORM_LIMITS = {
  /** Per uploaded file; a field may set a lower limit. */
  maxFileBytes: 25 * 1024 * 1024,
  maxInvitationsPerBatch: 500,
  maxExportRows: 50_000,
  /** Session tokens let a respondent come back on the same device. */
  sessionTtlSeconds: 7 * 24 * 60 * 60,
  /** Email codes for verified-email forms (as WeldSign). */
  codeTtlSeconds: 10 * 60,
  codeMaxAttempts: 5,
  codeLockSeconds: 15 * 60,
  /** An unfinished response untouched this long counts as abandoned (computed on read). */
  abandonedAfterSeconds: 24 * 60 * 60,
  /** Minimum time between start and submit before a submission looks automated. */
  minFillMs: 1500,
} as const;

/** Completed responses per calendar month by plan code; null = unlimited. Open item in the plan. */
export const FORM_RESPONSE_QUOTAS: Record<string, number | null> = {
  free: 100,
  starter: 1_000,
  pro: 10_000,
  business: null,
  enterprise: null,
};

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const isoDate = z.string().datetime({ offset: true });
const idParam = z.string().min(1).max(30);

/** Operational settings, not versioned: they apply as soon as they are saved. */
export const formSettingsSchema = z.object({
  respondentMode: z.enum(FORM_RESPONDENT_MODES).default('anyone'),
  /**
   * One response per person: per verified email, invitation or member. On
   * `anyone` forms a soft per-browser limit, labelled as such in the UI.
   */
  onePerRespondent: z.boolean().default(false),
  /** Verified-email forms: respondents may change their response until the form closes. */
  allowEdit: z.boolean().default(false),
  /** Members-only forms: store no member id on the response, only a keyed hash. */
  hideMemberIdentity: z.boolean().default(false),
  /** Keep answers of unfinished responses and show them, labelled. */
  collectPartial: z.boolean().default(false),
  opensAt: isoDate.nullable().default(null),
  closesAt: isoDate.nullable().default(null),
  responseLimit: z.number().int().min(1).max(1_000_000).nullable().default(null),
  closedMessage: z.string().max(1000).nullable().default(null),
  /** Hostnames allowed to embed the form (`example.com` also allows subdomains); empty = any site. */
  allowedEmbedDomains: z.array(z.string().min(1).max(255)).max(50).default([]),
  /** Email the respondent a copy of their answers; only ever to a verified address. */
  sendReceipt: z.boolean().default(false),
});
export type FormSettings = z.infer<typeof formSettingsSchema>;
export type FormSettingsInput = z.input<typeof formSettingsSchema>;

export const formUserRefSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  imageUrl: z.string().nullable().optional(),
});
export type FormUserRef = z.infer<typeof formUserRefSchema>;

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export const formSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(FORM_STATUSES),
  folderId: z.string().nullable(),
  layout: z.enum(FORM_LAYOUTS),
  publicId: z.string().nullable(),
  /** `https://forms.weldsuite.org/f/<publicId>` (the deployment's portal origin). */
  publicUrl: z.string().nullable(),
  access: z.enum(FORM_ACCESS_LEVELS),
  respondentMode: z.enum(FORM_RESPONDENT_MODES),
  owner: formUserRefSchema,
  responseCount: z.number().int(),
  lastResponseAt: isoDate.nullable(),
  hasUnpublishedChanges: z.boolean(),
  publishedAt: isoDate.nullable(),
  closedAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type FormSummary = z.infer<typeof formSummarySchema>;

export const formDetailSchema = formSummarySchema.extend({
  definition: formDefinitionSchema,
  settings: formSettingsSchema,
  themeId: z.string().nullable(),
  revision: z.number().int(),
  publishedVersion: z.object({ id: z.string(), number: z.number().int(), publishedAt: isoDate }).nullable(),
  /** What the signed-in member may do on this form. */
  permissions: z.object({
    edit: z.boolean(),
    publish: z.boolean(),
    delete: z.boolean(),
    send: z.boolean(),
    readResponses: z.boolean(),
    exportResponses: z.boolean(),
    deleteResponses: z.boolean(),
    manageAccess: z.boolean(),
  }),
  /** Set when staff suspended the form or the content screen holds it. */
  moderation: z
    .object({ state: z.enum(['suspended', 'held']), reason: z.string().nullable() })
    .nullable(),
});
export type FormDetail = z.infer<typeof formDetailSchema>;

export const listFormsQuerySchema = z.object({
  folderId: z.string().max(30).optional(),
  status: z.enum(FORM_STATUSES).optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(['updated', 'created', 'title', 'responses']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListFormsQuery = z.infer<typeof listFormsQuerySchema>;

export const createFormSchema = z.object({
  title: z.string().trim().min(1).max(255),
  folderId: z.string().max(30).nullable().optional(),
  /** A `STARTER_TEMPLATES` id from `@weldsuite/forms-engine`. */
  templateId: z.string().max(60).optional(),
  /** A ready definition (AI-generated, imported); wins over `templateId`. */
  definition: formDefinitionSchema.optional(),
  layout: z.enum(FORM_LAYOUTS).optional(),
});
export type CreateFormInput = z.infer<typeof createFormSchema>;

/** A draft save. `revision` is the one the editor loaded; an older one gets 409 `REVISION_CONFLICT`. */
export const updateFormSchema = z.object({
  revision: z.number().int().min(1),
  title: z.string().trim().min(1).max(255).optional(),
  folderId: z.string().max(30).nullable().optional(),
  definition: formDefinitionSchema.optional(),
  settings: formSettingsSchema.partial().optional(),
  themeId: z.string().max(30).nullable().optional(),
  access: z.enum(FORM_ACCESS_LEVELS).optional(),
});
export type UpdateFormInput = z.infer<typeof updateFormSchema>;

export const duplicateFormSchema = z.object({ title: z.string().trim().min(1).max(255).optional() });
export type DuplicateFormInput = z.infer<typeof duplicateFormSchema>;

/**
 * Publishing refuses with 422 `INVALID_DEFINITION` (details: the engine's
 * `DefinitionIssue[]`) or `NO_QUESTIONS`. A form the content screen flags
 * publishes but is held for review (`moderation.state = 'held'`).
 */
export const publishResultSchema = z.object({
  form: formDetailSchema,
  version: z.object({ id: z.string(), number: z.number().int() }),
});
export type PublishFormResult = z.infer<typeof publishResultSchema>;

export const formVersionSummarySchema = z.object({
  id: z.string(),
  number: z.number().int(),
  publishedAt: isoDate,
  publishedBy: formUserRefSchema,
  responseCount: z.number().int(),
});
export type FormVersionSummary = z.infer<typeof formVersionSummarySchema>;

export const formVersionDetailSchema = formVersionSummarySchema.extend({
  definition: formDefinitionSchema,
  theme: formThemeTokensSchema.nullable(),
});
export type FormVersionDetail = z.infer<typeof formVersionDetailSchema>;

export const formAccessEntrySchema = z.object({
  user: formUserRefSchema,
  role: z.enum(FORM_ACCESS_ROLES),
});
export type FormAccessEntry = z.infer<typeof formAccessEntrySchema>;

/** Replaces the access list of a form (owner and `forms:manage` always have access). */
export const setFormAccessSchema = z.object({
  entries: z.array(z.object({ userId: z.string().min(1).max(255), role: z.enum(FORM_ACCESS_ROLES) })).max(200),
});
export type SetFormAccessInput = z.infer<typeof setFormAccessSchema>;

// ---------------------------------------------------------------------------
// Folders, themes, settings, usage
// ---------------------------------------------------------------------------

export const formFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number().int(),
  formCount: z.number().int(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type FormFolder = z.infer<typeof formFolderSchema>;

export const createFormFolderSchema = z.object({ name: z.string().trim().min(1).max(255) });
export type CreateFormFolderInput = z.infer<typeof createFormFolderSchema>;
export const updateFormFolderSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  position: z.number().int().min(0).optional(),
});
export type UpdateFormFolderInput = z.infer<typeof updateFormFolderSchema>;

export const formThemeSchema = z.object({
  id: z.string(),
  name: z.string(),
  tokens: formThemeTokensSchema,
  isDefault: z.boolean(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type FormTheme = z.infer<typeof formThemeSchema>;

export const createFormThemeSchema = z.object({
  name: z.string().trim().min(1).max(255),
  tokens: formThemeTokensSchema,
  isDefault: z.boolean().optional(),
});
export type CreateFormThemeInput = z.infer<typeof createFormThemeSchema>;
export const updateFormThemeSchema = createFormThemeSchema.partial();
export type UpdateFormThemeInput = z.infer<typeof updateFormThemeSchema>;

export const formsWorkspaceSettingsSchema = z.object({
  defaultThemeId: z.string().nullable(),
  senderName: z.string().nullable(),
  reminderAfterDays: z.number().int().min(1).max(30).nullable(),
  reminderEveryDays: z.number().int().min(1).max(30).nullable(),
  reminderMaxCount: z.number().int().min(0).max(5),
  showBadge: z.boolean(),
  /** Paid plans may switch the "Made with WeldForms" badge off. */
  canHideBadge: z.boolean(),
});
export type FormsWorkspaceSettings = z.infer<typeof formsWorkspaceSettingsSchema>;

export const updateFormsWorkspaceSettingsSchema = formsWorkspaceSettingsSchema.omit({ canHideBadge: true }).partial();
export type UpdateFormsWorkspaceSettingsInput = z.infer<typeof updateFormsWorkspaceSettingsSchema>;

export const formsUsageSchema = z.object({
  periodStart: isoDate,
  periodEnd: isoDate,
  /** Completed responses this calendar month (UTC). */
  used: z.number().int(),
  /** null = unlimited. */
  limit: z.number().int().nullable(),
  plan: z.string().nullable(),
});
export type FormsUsage = z.infer<typeof formsUsageSchema>;

export const mediaUploadResultSchema = z.object({ url: z.string().url(), contentType: z.string(), size: z.number().int() });
export type FormMediaUploadResult = z.infer<typeof mediaUploadResultSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const formResponseFileSchema = fileAnswerItemSchema.extend({
  blockId: z.string(),
  kind: z.enum(['upload', 'signature']),
  /** Member download path (`/api/forms/forms/:id/responses/:rid/files/:fileId`). */
  downloadPath: z.string(),
});
export type FormResponseFile = z.infer<typeof formResponseFileSchema>;

export const formResponseActionSchema = z.object({
  id: z.string(),
  integrationId: z.string(),
  kind: z.enum(FORM_INTEGRATION_KINDS),
  status: z.enum(FORM_ACTION_STATUSES),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  error: z.string().nullable(),
  attempts: z.number().int(),
  updatedAt: isoDate,
});
export type FormResponseAction = z.infer<typeof formResponseActionSchema>;

export const formResponseSchema = z.object({
  id: z.string(),
  formId: z.string(),
  versionId: z.string(),
  versionNumber: z.number().int(),
  number: z.number().int().nullable(),
  status: z.enum(FORM_RESPONSE_STATUSES),
  /** In-progress responses of forms that don't collect partials have `{}`. */
  answers: z.record(z.unknown()),
  hidden: z.record(z.string()),
  variables: z.record(z.union([z.number(), z.string()])),
  score: z.number().nullable(),
  endingId: z.string().nullable(),
  respondentEmail: z.string().nullable(),
  respondent: formUserRefSchema.nullable(),
  personId: z.string().nullable(),
  invitationId: z.string().nullable(),
  lastBlockId: z.string().nullable(),
  answeredCount: z.number().int(),
  /** In progress and untouched for 24 hours. */
  abandoned: z.boolean(),
  metadata: z.object({
    referrer: z.string().optional(),
    utm: z.record(z.string()).optional(),
    source: z.string().optional(),
    device: z.enum(['desktop', 'tablet', 'phone']).optional(),
    browser: z.string().optional(),
    os: z.string().optional(),
    country: z.string().optional(),
  }),
  files: z.array(formResponseFileSchema),
  startedAt: isoDate,
  submittedAt: isoDate.nullable(),
  durationMs: z.number().int().nullable(),
  updatedAt: isoDate,
});
export type FormResponseDto = z.infer<typeof formResponseSchema>;

export const formResponseDetailSchema = formResponseSchema.extend({
  actions: z.array(formResponseActionSchema),
});
export type FormResponseDetail = z.infer<typeof formResponseDetailSchema>;

/** One filter on answers in the responses list; JSON-encoded array in `filters`. */
export const responseAnswerFilterSchema = z.object({
  blockId: z.string().max(30),
  /** Contact info / address sub-field. */
  part: z.string().max(30).optional(),
  operator: z.enum(['is', 'is_not', 'contains', 'any_of', 'none_of', 'greater_than', 'less_than', 'is_answered', 'is_empty']),
  value: z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(30)).max(100)]).optional(),
});
export type ResponseAnswerFilter = z.infer<typeof responseAnswerFilterSchema>;

export const listFormResponsesQuerySchema = z.object({
  status: z.enum(['completed', 'in_progress', 'all']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().max(200).optional(),
  versionId: z.string().max(30).optional(),
  personId: z.string().max(30).optional(),
  invitationId: z.string().max(30).optional(),
  /** JSON: `ResponseAnswerFilter[]`. */
  filters: z.string().max(5000).optional(),
  sort: z.enum(['newest', 'oldest', 'score_desc', 'score_asc']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListFormResponsesQuery = z.infer<typeof listFormResponsesQuerySchema>;

export const exportFormResponsesQuerySchema = listFormResponsesQuerySchema
  .omit({ cursor: true, limit: true })
  .extend({ format: z.enum(['csv', 'xlsx']) });
export type ExportFormResponsesQuery = z.infer<typeof exportFormResponsesQuerySchema>;

/** A CRM person's responses across the forms the member may read (`GET /api/forms/responses?personId=`). */
export const listPersonResponsesQuerySchema = z.object({
  personId: z.string().min(1).max(30),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListPersonResponsesQuery = z.infer<typeof listPersonResponsesQuerySchema>;

export const personFormResponseSchema = formResponseSchema.extend({ formTitle: z.string() });
export type PersonFormResponse = z.infer<typeof personFormResponseSchema>;

/** A column of the responses table and the export, merged across versions by block id. */
export const formResponseColumnSchema = z.object({
  key: z.string(),
  /** Absent for metadata columns (number, submitted at, email, score, …). */
  blockId: z.string().optional(),
  part: z.string().optional(),
  label: z.string(),
  type: z.string(),
  /** Version numbers that have this field; a field removed later stays as a column. */
  versions: z.array(z.number().int()),
});
export type FormResponseColumn = z.infer<typeof formResponseColumnSchema>;

export const bulkDeleteFormResponsesSchema = z.object({ ids: z.array(idParam).min(1).max(500) });
export type BulkDeleteFormResponsesInput = z.infer<typeof bulkDeleteFormResponsesSchema>;

/** GDPR erase: every response (and its files) whose respondent email matches, across all forms. */
export const eraseRespondentSchema = z.object({ email: z.string().trim().email().max(320) });
export type EraseRespondentInput = z.infer<typeof eraseRespondentSchema>;
export const eraseRespondentResultSchema = z.object({ responsesDeleted: z.number().int(), formsAffected: z.number().int() });
export type EraseRespondentResult = z.infer<typeof eraseRespondentResultSchema>;

// ---------------------------------------------------------------------------
// Summary and insights
// ---------------------------------------------------------------------------

const countItem = z.object({ id: z.string(), label: z.string(), count: z.number().int(), percent: z.number() });
const latestItem = z.object({ responseId: z.string(), value: z.string(), submittedAt: isoDate });

export const formFieldSummarySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('choice'), blockId: z.string(), type: z.string(), title: z.string(), answered: z.number().int(), choices: z.array(countItem), other: z.number().int(), otherLatest: z.array(latestItem) }),
  z.object({
    kind: z.literal('numeric'),
    blockId: z.string(),
    type: z.string(),
    title: z.string(),
    answered: z.number().int(),
    average: z.number().nullable(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    distribution: z.array(z.object({ value: z.number(), count: z.number().int() })),
  }),
  z.object({
    kind: z.literal('nps'),
    blockId: z.string(),
    type: z.string(),
    title: z.string(),
    answered: z.number().int(),
    /** -100..100 */
    score: z.number().nullable(),
    promoters: z.number().int(),
    passives: z.number().int(),
    detractors: z.number().int(),
    distribution: z.array(z.object({ value: z.number(), count: z.number().int() })),
  }),
  z.object({ kind: z.literal('boolean'), blockId: z.string(), type: z.string(), title: z.string(), answered: z.number().int(), yes: z.number().int(), no: z.number().int() }),
  z.object({ kind: z.literal('text'), blockId: z.string(), type: z.string(), title: z.string(), answered: z.number().int(), latest: z.array(latestItem) }),
  z.object({
    kind: z.literal('matrix'),
    blockId: z.string(),
    type: z.string(),
    title: z.string(),
    answered: z.number().int(),
    columns: z.array(z.object({ id: z.string(), label: z.string() })),
    rows: z.array(z.object({ id: z.string(), label: z.string(), counts: z.record(z.number().int()) })),
  }),
  z.object({
    kind: z.literal('ranking'),
    blockId: z.string(),
    type: z.string(),
    title: z.string(),
    answered: z.number().int(),
    choices: z.array(z.object({ id: z.string(), label: z.string(), averageRank: z.number().nullable() })),
  }),
  z.object({ kind: z.literal('files'), blockId: z.string(), type: z.string(), title: z.string(), answered: z.number().int(), files: z.number().int() }),
]);
export type FormFieldSummary = z.infer<typeof formFieldSummarySchema>;

export const formSummaryQuerySchema = z.object({
  versionId: z.string().max(30).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type FormSummaryQuery = z.infer<typeof formSummaryQuerySchema>;

export const formResultsSummarySchema = z.object({
  totalResponses: z.number().int(),
  averageScore: z.number().nullable(),
  fields: z.array(formFieldSummarySchema),
});
export type FormResultsSummary = z.infer<typeof formResultsSummarySchema>;

export const formInsightsSchema = z.object({
  views: z.number().int(),
  starts: z.number().int(),
  completions: z.number().int(),
  /** completions / starts, 0..1; null without starts. */
  completionRate: z.number().nullable(),
  averageDurationMs: z.number().nullable(),
  byDay: z.array(z.object({ date: z.string(), views: z.number().int(), starts: z.number().int(), completions: z.number().int() })),
  dropOff: z.array(
    z.object({ blockId: z.string(), title: z.string(), reached: z.number().int(), leftHere: z.number().int(), dropOffRate: z.number() }),
  ),
  bySource: z.array(z.object({ source: z.string(), starts: z.number().int(), completions: z.number().int() })),
});
export type FormInsights = z.infer<typeof formInsightsSchema>;

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export const invitationRemindersSchema = z.object({
  afterDays: z.number().int().min(1).max(30),
  everyDays: z.number().int().min(1).max(30),
  maxCount: z.number().int().min(0).max(5),
});
export type InvitationReminders = z.infer<typeof invitationRemindersSchema>;

export const createFormInvitationsSchema = z.object({
  recipients: z
    .object({
      emails: z.array(z.object({ email: z.string().trim().email().max(320), name: z.string().max(255).optional() })).max(500).optional(),
      userIds: z.array(z.string().max(255)).max(500).optional(),
      personIds: z.array(z.string().max(30)).max(500).optional(),
      /** A CRM list of people (CRM-003). */
      listId: z.string().max(30).optional(),
    })
    .refine((r) => Boolean(r.emails?.length || r.userIds?.length || r.personIds?.length || r.listId), {
      message: 'Pick at least one recipient',
    }),
  subject: z.string().trim().min(1).max(255).optional(),
  message: z.string().max(5000).optional(),
  locale: z.enum(FORM_LOCALES).optional(),
  /** null = no automatic reminders; absent = the workspace defaults. */
  reminders: invitationRemindersSchema.nullable().optional(),
});
export type CreateFormInvitationsInput = z.infer<typeof createFormInvitationsSchema>;

export const createFormInvitationsResultSchema = z.object({
  created: z.number().int(),
  skipped: z.array(z.object({ email: z.string(), reason: z.enum(['duplicate', 'invalid', 'no_email', 'already_responded']) })),
});
export type CreateFormInvitationsResult = z.infer<typeof createFormInvitationsResultSchema>;

export const formInvitationSchema = z.object({
  id: z.string(),
  formId: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  personId: z.string().nullable(),
  userId: z.string().nullable(),
  locale: z.enum(FORM_LOCALES),
  status: z.enum(FORM_INVITATION_STATUSES),
  remindersSent: z.number().int(),
  responseId: z.string().nullable(),
  sentAt: isoDate.nullable(),
  openedAt: isoDate.nullable(),
  startedAt: isoDate.nullable(),
  completedAt: isoDate.nullable(),
  lastRemindedAt: isoDate.nullable(),
  nextReminderAt: isoDate.nullable(),
  revokedAt: isoDate.nullable(),
  createdAt: isoDate,
});
export type FormInvitation = z.infer<typeof formInvitationSchema>;

export const listFormInvitationsQuerySchema = z.object({
  status: z.enum(FORM_INVITATION_STATUSES).optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListFormInvitationsQuery = z.infer<typeof listFormInvitationsQuerySchema>;

export const formInvitationStatsSchema = z.object({
  total: z.number().int(),
  sent: z.number().int(),
  opened: z.number().int(),
  started: z.number().int(),
  completed: z.number().int(),
  revoked: z.number().int(),
});
export type FormInvitationStats = z.infer<typeof formInvitationStatsSchema>;

/** Remind the given invitations, or everyone who hasn't completed when `invitationIds` is absent. */
export const remindFormInvitationsSchema = z.object({ invitationIds: z.array(idParam).max(500).optional() });
export type RemindFormInvitationsInput = z.infer<typeof remindFormInvitationsSchema>;
export const remindFormInvitationsResultSchema = z.object({ reminded: z.number().int(), skipped: z.number().int() });
export type RemindFormInvitationsResult = z.infer<typeof remindFormInvitationsResultSchema>;

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

const recallTemplate = z.string().max(5000);

export const crmIntegrationConfigSchema = z.object({
  /** Create or update a person, or create a lead (CRM-007). */
  target: z.enum(['person', 'lead']).default('person'),
  /** The email or contact-info field that identifies the person. */
  emailFieldId: z.string().max(30),
  /** Create the company from a company field or the email domain. */
  createCompany: z.boolean().default(false),
  companyFieldId: z.string().max(30).optional(),
  mappings: z
    .array(
      z.object({
        blockId: z.string().max(30),
        part: z.string().max(30).optional(),
        /** A standard person/lead field key, or `custom:<customFieldId>`. */
        crmField: z.string().max(100),
        mode: z.enum(['overwrite', 'fill_empty']).default('fill_empty'),
      }),
    )
    .max(100)
    .default([]),
  listId: z.string().max(30).optional(),
  tags: z.array(z.string().max(100)).max(20).default([]),
  logActivity: z.boolean().default(true),
});
export type CrmIntegrationConfig = z.infer<typeof crmIntegrationConfigSchema>;

export const deskIntegrationConfigSchema = z.object({
  /** WeldDesk department (team) the ticket goes to; the workspace routing rules decide when absent. */
  departmentId: z.string().max(30).optional(),
  subject: recallTemplate.default('{{form:title}} #{{response:number}}'),
  /** Empty = every answer as "Question: answer" lines. */
  body: recallTemplate.default(''),
  /** The email field whose value becomes the requester; the verified email otherwise. */
  requesterFieldId: z.string().max(30).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  tags: z.array(z.string().max(100)).max(20).default([]),
  attachFiles: z.boolean().default(true),
});
export type DeskIntegrationConfig = z.infer<typeof deskIntegrationConfigSchema>;

export const flowIntegrationConfigSchema = z.object({
  /** null = a personal task of the assignee. */
  projectId: z.string().max(30).nullable().default(null),
  title: recallTemplate.default('{{form:title}} #{{response:number}}'),
  description: recallTemplate.default(''),
  assigneeUserId: z.string().max(255).optional(),
  /** A date field whose answer becomes the due date. */
  dueDateFieldId: z.string().max(30).optional(),
  labels: z.array(z.string().max(100)).max(20).default([]),
  attachFiles: z.boolean().default(true),
});
export type FlowIntegrationConfig = z.infer<typeof flowIntegrationConfigSchema>;

export const formIntegrationInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('crm'), enabled: z.boolean().default(true), config: crmIntegrationConfigSchema }),
  z.object({ kind: z.literal('desk'), enabled: z.boolean().default(true), config: deskIntegrationConfigSchema }),
  z.object({ kind: z.literal('flow'), enabled: z.boolean().default(true), config: flowIntegrationConfigSchema }),
]);
export type FormIntegrationInput = z.infer<typeof formIntegrationInputSchema>;

export const updateFormIntegrationSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});
export type UpdateFormIntegrationInput = z.infer<typeof updateFormIntegrationSchema>;

export const formIntegrationSchema = z.object({
  id: z.string(),
  formId: z.string(),
  kind: z.enum(FORM_INTEGRATION_KINDS),
  enabled: z.boolean(),
  config: z.record(z.unknown()),
  createdBy: formUserRefSchema,
  lastError: z.string().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type FormIntegration = z.infer<typeof formIntegrationSchema>;

/** Recall in integration templates: the engine's tokens plus `{{form:title}}`, `{{response:number}}`, `{{response:url}}`. */
export const INTEGRATION_EXTRA_TOKENS = ['form:title', 'response:number', 'response:url'] as const;

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export const formSubscriptionSchema = z.object({ mode: z.enum(FORM_SUBSCRIPTION_MODES) });
export type FormSubscription = z.infer<typeof formSubscriptionSchema>;

// ---------------------------------------------------------------------------
// AI (Global only; the Rust backend answers 503 `ai_unavailable`, ADR AI-011)
// ---------------------------------------------------------------------------

export const generateFormSchema = z.object({
  prompt: z.string().trim().min(10).max(2000),
  layout: z.enum(FORM_LAYOUTS).optional(),
  language: z.enum(FORM_LANGUAGES).optional(),
});
export type GenerateFormInput = z.infer<typeof generateFormSchema>;
export const generateFormResultSchema = z.object({ title: z.string(), definition: formDefinitionSchema });
export type GenerateFormResult = z.infer<typeof generateFormResultSchema>;

export const suggestBlocksSchema = z.object({
  prompt: z.string().trim().min(3).max(1000),
  /** The draft as the builder has it, for context and unique ids. */
  definition: formDefinitionSchema,
});
export type SuggestBlocksInput = z.infer<typeof suggestBlocksSchema>;
export const suggestBlocksResultSchema = z.object({ blocks: z.array(blockSchema) });
export type SuggestBlocksResult = z.infer<typeof suggestBlocksResultSchema>;

export const aiSummaryContentSchema = z.object({
  overview: z.string(),
  themes: z.array(z.object({ label: z.string(), count: z.number().int(), quotes: z.array(z.string()).max(3) })),
  sentiment: z.object({ positive: z.number().int(), neutral: z.number().int(), negative: z.number().int() }).nullable(),
});
export type AiSummaryContent = z.infer<typeof aiSummaryContentSchema>;

export const formAiSummarySchema = z.object({
  blockId: z.string().nullable(),
  summary: aiSummaryContentSchema.nullable(),
  /** Made from fewer responses than there are now. */
  stale: z.boolean(),
  responseCount: z.number().int(),
  createdAt: isoDate.nullable(),
});
export type FormAiSummary = z.infer<typeof formAiSummarySchema>;

export const createAiSummarySchema = z.object({ blockId: z.string().max(30).nullable().default(null) });
export type CreateAiSummaryInput = z.infer<typeof createAiSummarySchema>;

// ---------------------------------------------------------------------------
// Members-only forms (answered inside the platform)
// ---------------------------------------------------------------------------

export const memberFillSchema = z.object({
  form: z.lazy(() => publicFormSchema),
  /** The member's earlier response when the form allows one per member. */
  alreadyResponded: z.boolean(),
});
export type MemberFill = z.infer<typeof memberFillSchema>;

export const memberSubmitSchema = z.object({
  answers: z.record(z.unknown()),
  hidden: z.record(z.string().max(1000)).optional(),
  timings: z.record(z.number().int().min(0)).optional(),
});
export type MemberSubmitInput = z.infer<typeof memberSubmitSchema>;

/** `POST /api/forms/fill/:publicId/uploads` (multipart `blockId` + `file`): the stored file, as the field's answer item. */
export const memberUploadResultSchema = z.object({ file: fileAnswerItemSchema });
export type MemberUploadResult = z.infer<typeof memberUploadResultSchema>;

// ---------------------------------------------------------------------------
// Public routes (/public/forms/*, forms-portal only)
// ---------------------------------------------------------------------------

/** Headers forms-portal sends with every public call. */
export const FORMS_PORTAL_HEADERS = {
  key: 'X-Forms-Portal-Key',
  ip: 'X-Respondent-Ip',
  country: 'X-Respondent-Country',
} as const;

export const BOT_CHECK_PROVIDERS = ['turnstile', 'altcha', 'none'] as const;
export type BotCheckProvider = (typeof BOT_CHECK_PROVIDERS)[number];

export const publicFormSchema = z.object({
  publicId: z.string(),
  title: z.string(),
  state: z.enum(PUBLIC_FORM_STATES),
  closedMessage: z.string().nullable(),
  versionId: z.string().nullable(),
  /** The published version; null when the form never went live. */
  definition: formDefinitionSchema.nullable(),
  theme: formThemeTokensSchema,
  respondentMode: z.enum(FORM_RESPONDENT_MODES),
  onePerRespondent: z.boolean(),
  allowEdit: z.boolean(),
  collectPartial: z.boolean(),
  allowedEmbedDomains: z.array(z.string()),
  botCheck: z.object({
    provider: z.enum(BOT_CHECK_PROVIDERS),
    /** Turnstile site key. */
    siteKey: z.string().nullable(),
  }),
  branding: z.object({
    workspaceName: z.string(),
    logoUrl: z.string().nullable(),
    showBadge: z.boolean(),
  }),
  /** Members-only forms: where the portal sends the respondent (the platform fill page). */
  membersUrl: z.string().nullable(),
});
export type PublicForm = z.infer<typeof publicFormSchema>;

export const sessionMetadataSchema = z.object({
  referrer: z.string().max(2000).optional(),
  utm: z.record(z.string().max(200)).optional(),
  /** `link`, `invitation`, `qr`, or the embed mode. */
  source: z.string().max(30).optional(),
  device: z.enum(['desktop', 'tablet', 'phone']).optional(),
  browser: z.string().max(60).optional(),
  os: z.string().max(60).optional(),
});
export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

export const startSessionSchema = z.object({
  /** Turnstile token or ALTCHA payload; required unless the provider is `none`. */
  botToken: z.string().max(5000).optional(),
  /** From `/i/<token>`: a personal invitation link. */
  invitationToken: z.string().min(20).max(200).optional(),
  /** From `/verify` on verified-email forms. */
  verification: z.string().max(500).optional(),
  /** A session token from an earlier visit, to resume. */
  resume: z.string().max(1000).optional(),
  /** A random id the browser keeps per form, for the soft one-per-browser limit. */
  browserKey: z.string().max(64).optional(),
  hidden: z.record(z.string().max(1000)).optional(),
  metadata: sessionMetadataSchema.optional(),
});
export type StartSessionInput = z.infer<typeof startSessionSchema>;

export const startSessionResultSchema = z.object({
  /** Bearer token for the session routes. */
  session: z.string(),
  responseId: z.string(),
  versionId: z.string(),
  expiresAt: isoDate,
  /** Answers saved earlier (resume with partials, or editing a completed response). */
  answers: z.record(z.unknown()),
  hidden: z.record(z.string()),
  lastBlockId: z.string().nullable(),
  /** Verified email, invitation email or null. */
  respondentEmail: z.string().nullable(),
  /** The respondent already completed this form (one per person): editable when the form allows it. */
  completed: z.object({ editable: z.boolean() }).nullable(),
});
export type StartSessionResult = z.infer<typeof startSessionResultSchema>;

export const sendCodeSchema = z.object({ email: z.string().trim().email().max(320), botToken: z.string().max(5000).optional() });
export type SendCodeInput = z.infer<typeof sendCodeSchema>;
export const sendCodeResultSchema = z.object({ expiresInSeconds: z.number().int() });
export type SendCodeResult = z.infer<typeof sendCodeResultSchema>;

export const verifyCodeSchema = z.object({ email: z.string().trim().email().max(320), code: z.string().regex(/^\d{6}$/) });
export type VerifyCodeInput = z.infer<typeof verifyCodeSchema>;
/** 400 `INVALID_CODE` with `details.attemptsLeft`, 429 `LOCKED`. */
export const verifyCodeResultSchema = z.object({ verification: z.string() });
export type VerifyCodeResult = z.infer<typeof verifyCodeResultSchema>;

export const saveProgressSchema = z.object({
  lastBlockId: z.string().max(30),
  /** Stored only when the form collects partial responses; ignored otherwise. */
  answers: z.record(z.unknown()).optional(),
  /** Milliseconds per block id since the last save. */
  timings: z.record(z.number().int().min(0).max(86_400_000)).optional(),
});
export type SaveProgressInput = z.infer<typeof saveProgressSchema>;

export const uploadResultSchema = z.object({ file: fileAnswerItemSchema });
export type SessionUploadResult = z.infer<typeof uploadResultSchema>;

export const submitSessionSchema = z.object({
  answers: z.record(z.unknown()),
  timings: z.record(z.number().int().min(0).max(86_400_000)).optional(),
  /** Honeypot: a hidden input real people leave empty. */
  website: z.string().max(500).optional(),
});
export type SubmitSessionInput = z.infer<typeof submitSessionSchema>;

/**
 * 422 `VALIDATION_FAILED` with `details.fields`: `Record<fieldId, AnswerError>`
 * (the engine's codes) when an answer is missing or wrong.
 */
export const submitSessionResultSchema = z.object({
  responseId: z.string(),
  number: z.number().int(),
  ending: z.object({
    id: z.string(),
    /** Recall already filled in. */
    title: z.string(),
    description: z.string().nullable(),
    redirectUrl: z.string().nullable(),
    button: z.object({ text: z.string(), url: z.string() }).nullable(),
    showScore: z.boolean(),
    showAnswers: z.boolean(),
  }),
  score: z.number(),
  /** Only when the ending shows answers. */
  quiz: z
    .array(
      z.object({
        fieldId: z.string(),
        correct: z.boolean().nullable(),
        points: z.number(),
        /**
         * The labels of the question's correct choices, joined with ', '; null
         * when none is marked. The public definition leaves `correct` out, so
         * the review on the ending reads the right answer from here.
         */
        correctAnswer: z.string().nullable(),
      }),
    )
    .nullable(),
});
export type SubmitSessionResult = z.infer<typeof submitSessionResultSchema>;

export const recordViewSchema = z.object({
  /** Random per browser tab, so a reload isn't a second view. */
  viewKey: z.string().min(8).max(64),
  source: z.string().max(30).optional(),
});
export type RecordViewInput = z.infer<typeof recordViewSchema>;

export const reportAbuseSchema = z.object({
  reason: z.enum(FORM_ABUSE_REASONS),
  details: z.string().max(2000).optional(),
  email: z.string().trim().email().max(320).optional(),
});
export type ReportAbuseInput = z.infer<typeof reportAbuseSchema>;

// ---------------------------------------------------------------------------
// Re-exports for consumers that only import the API contract
// ---------------------------------------------------------------------------

export type { Answers, FormDefinition, FormThemeTokens };
