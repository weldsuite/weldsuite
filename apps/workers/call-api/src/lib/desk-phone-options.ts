/**
 * What a number's inbound route says about ringing, waiting and speaking,
 * with defaults filled in, and the texts the phone flows speak.
 */

import { and, eq, isNull } from 'drizzle-orm';
import {
  DESK_PHONE_DEFAULT_MAX_WAIT_SECONDS,
  DESK_PHONE_DEFAULT_RING_SECONDS,
  type DeskPhoneMenu,
  type DeskPhoneRouteOptions,
  type DeskPhoneUnansweredAction,
} from '@weldsuite/db/schema/desk-phone-routes';
import { schema, type Database } from '@weldsuite/worker-kit/db';

export type PhoneRouteRow = typeof schema.deskPhoneRoutes.$inferSelect;

export interface ResolvedRouteOptions {
  greeting: string | null;
  language: string;
  departmentId: string | null;
  ringSeconds: number;
  maxWaitSeconds: number;
  whenUnanswered: DeskPhoneUnansweredAction;
  voicemailGreeting: string | null;
  menu: DeskPhoneMenu | null;
}

export const DEFAULT_PHONE_LANGUAGE = 'en-US';
export const PHONE_VOICE = 'female';

export function resolveRouteOptions(route: Pick<PhoneRouteRow, 'options'> | null | undefined): ResolvedRouteOptions {
  const o: DeskPhoneRouteOptions = route?.options ?? {};
  return {
    greeting: o.greeting?.trim() || null,
    language: o.language || DEFAULT_PHONE_LANGUAGE,
    departmentId: o.departmentId ?? null,
    ringSeconds: o.ringSeconds ?? DESK_PHONE_DEFAULT_RING_SECONDS,
    maxWaitSeconds: o.maxWaitSeconds ?? DESK_PHONE_DEFAULT_MAX_WAIT_SECONDS,
    whenUnanswered: o.whenUnanswered ?? 'voicemail',
    voicemailGreeting: o.voicemailGreeting?.trim() || null,
    menu: o.menu ?? null,
  };
}

/** The route of the number a call was dialled on, or null. */
export async function loadRouteForNumber(db: Database, toNumber: string): Promise<PhoneRouteRow | null> {
  const [phone] = await db
    .select({ id: schema.voipPhoneNumbers.id })
    .from(schema.voipPhoneNumbers)
    .where(and(eq(schema.voipPhoneNumbers.phoneNumber, toNumber), isNull(schema.voipPhoneNumbers.deletedAt)))
    .limit(1);
  if (!phone) return null;
  const [route] = await db
    .select()
    .from(schema.deskPhoneRoutes)
    .where(eq(schema.deskPhoneRoutes.voipPhoneNumberId, phone.id))
    .limit(1);
  return route ?? null;
}

function isDutch(language: string): boolean {
  return language.toLowerCase().startsWith('nl');
}

export function defaultVoicemailGreeting(language: string): string {
  return isDutch(language) ? 'Laat na de piep een bericht achter.' : 'Please leave a message after the tone.';
}

export function invalidChoicePrompt(language: string): string {
  return isDutch(language) ? 'Dat is geen geldige keuze.' : 'That is not a valid choice.';
}

/** The Telnyx queue a call waits in: one per workspace and team (`all` is the general queue). */
export function phoneQueueName(workspaceId: string, departmentId: string | null): string {
  return `desk-${workspaceId}-${departmentId ?? 'all'}`;
}
