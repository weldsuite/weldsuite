import { eq, isNull } from 'drizzle-orm';
import { headers } from 'next/headers';
import { workspaceMembers, workspaceSettings } from '@weldsuite/db/schema';
import { resolveEmailLocale, type EmailBrand, type EmailLocale } from '@weldsuite/emails';

import type { getTenantDbBySlug } from '@/lib/db';
import {
  buildManageUrl,
  resolveLinkSecret,
  resolvePortalOrigin,
  signBookingToken,
  verifyBookingToken,
  type ManageAction,
} from '@/lib/booking-links';
import { bookingQuestionSchema, type BookingQuestion } from '@/lib/schemas';

type TenantDb = NonNullable<Awaited<ReturnType<typeof getTenantDbBySlug>>>['db'];

export interface HostInfo {
  /** The member who owns the booking page; falls back to the workspace name. */
  name: string;
  /** Where replies and the guest's questions should go. */
  email: string | null;
}

/** The host of a booking page is the workspace member who owns it. */
export async function getHostInfo(
  db: TenantDb,
  ownerId: string,
  workspaceName: string,
): Promise<HostInfo> {
  const [member] = await db
    .select({ name: workspaceMembers.name, email: workspaceMembers.email })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, ownerId))
    .limit(1);
  return {
    name: member?.name?.trim() || workspaceName,
    email: member?.email?.trim() || null,
  };
}

export interface WorkspaceBrand {
  brand: EmailBrand;
  locale: EmailLocale;
}

/**
 * The workspace's own brand (logo, accent color) and language for mail to
 * people outside the workspace (bookers, guests) — they must never see the
 * WeldSuite brand. Falls back to a name-only brand and English when the
 * tenant never saved settings.
 */
export async function getWorkspaceBrand(db: TenantDb, workspaceName: string): Promise<WorkspaceBrand> {
  const [settings] = await db
    .select({
      logoUrl: workspaceSettings.logoUrl,
      primaryColor: workspaceSettings.primaryColor,
      accentColor: workspaceSettings.accentColor,
      language: workspaceSettings.language,
    })
    .from(workspaceSettings)
    .where(isNull(workspaceSettings.deletedAt))
    .limit(1);

  return {
    brand: {
      kind: 'workspace',
      name: workspaceName,
      logoUrl: settings?.logoUrl?.trim() || undefined,
      // The workspace brand color, as the digest and portals use it.
      accentColor: settings?.primaryColor?.trim() || settings?.accentColor?.trim() || undefined,
    },
    locale: resolveEmailLocale(settings?.language),
  };
}

/** Questions stored on a booking page; anything malformed is ignored. */
export function parseQuestions(raw: unknown): BookingQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const parsed = bookingQuestionSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export type AnswersResult =
  | { ok: true; answers: Record<string, string> | undefined }
  | { ok: false };

/**
 * Keeps only answers to questions the page really has, and enforces required
 * questions on the server (the form's `required` attribute is client-side only).
 */
export function resolveAnswers(
  questions: BookingQuestion[],
  submitted: Record<string, string> | undefined,
): AnswersResult {
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const value = submitted?.[question.id]?.trim().slice(0, 2000) ?? '';
    if (question.required && !value) return { ok: false };
    if (question.type === 'select' && value && !question.options?.includes(value)) return { ok: false };
    if (value) answers[question.id] = value;
  }
  return { ok: true, answers: Object.keys(answers).length > 0 ? answers : undefined };
}

/** "Label: answer" lines for the event description / host notes. */
export function formatAnswerLines(
  questions: BookingQuestion[],
  answers: Record<string, string> | undefined,
): string[] {
  if (!answers) return [];
  return questions.flatMap((q) => (answers[q.id] ? [`${q.label}: ${answers[q.id]}`] : []));
}

export class MissingLinkSecretError extends Error {
  constructor() {
    super('BOOKING_LINK_SECRET (or DATABASE_ENCRYPTION_KEY) is not configured');
    this.name = 'MissingLinkSecretError';
  }
}

function requireLinkSecret(): string {
  const secret = resolveLinkSecret(process.env);
  if (!secret) throw new MissingLinkSecretError();
  return secret;
}

export function createManageToken(bookingId: string): Promise<string> {
  return signBookingToken(requireLinkSecret(), bookingId);
}

export function isValidManageToken(bookingId: string, token: string | null | undefined): Promise<boolean> {
  const secret = resolveLinkSecret(process.env);
  if (!secret) return Promise.resolve(false);
  return verifyBookingToken(secret, bookingId, token);
}

async function currentPortalOrigin(): Promise<string | null> {
  const h = await headers();
  return resolvePortalOrigin({
    override: process.env.BOOKING_PORTAL_URL,
    forwardedHost: h.get('x-forwarded-host'),
    host: h.get('host'),
    forwardedProto: h.get('x-forwarded-proto'),
  });
}

export interface ManageUrls {
  rescheduleUrl: string;
  cancelUrl: string;
}

/** Signed reschedule / cancel links for the emails, or null when the origin is unknown. */
export async function buildManageUrls(params: {
  workspaceSlug: string;
  pageSlug: string;
  bookingId: string;
  token: string;
}): Promise<ManageUrls | null> {
  const origin = await currentPortalOrigin();
  if (!origin) return null;
  const build = (action: ManageAction) => buildManageUrl({ ...params, origin, action });
  return { rescheduleUrl: build('reschedule'), cancelUrl: build('cancel') };
}
