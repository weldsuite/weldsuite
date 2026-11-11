/**
 * The phone route form: what the editor edits and how it becomes the
 * `PUT /api/desk/phone/routes` body. Validation runs the shared Zod schema the
 * server uses (`upsertDeskPhoneRouteSchema`), and server 400 / 404 answers are
 * mapped onto the same field keys. Pure, so it can be tested without rendering.
 *
 * Field keys: `voiceAgentId`, `forwardToE164`, `greeting`, `language`,
 * `departmentId`, `ringSeconds`, `maxWaitSeconds`, `voicemailGreeting`,
 * `menuPrompt`, `menuChoices`, `fallbackDigit` and `choice.<index>.<field>`.
 */

import {
  DESK_PHONE_MENU_DIGITS,
  upsertDeskPhoneRouteSchema,
  type DeskPhoneRouteAction,
  type DeskPhoneRouteOptionsInput,
  type UpsertDeskPhoneRoute,
} from '@weldsuite/core-api-client/schemas/desk-phone';
import type { DeskPhoneRoute } from '@/hooks/queries/use-desk-phone-settings-queries';

export type MenuDigit = (typeof DESK_PHONE_MENU_DIGITS)[number];
export type MenuChoiceAction = 'ai_agent' | 'agents' | 'forward' | 'voicemail';
export type UnansweredAction = 'voicemail' | 'hangup';

export { DESK_PHONE_MENU_DIGITS };
/** The actions of a number's route, in the order the select lists them. */
export const ROUTE_ACTIONS: DeskPhoneRouteAction[] = ['agents', 'menu', 'voicemail', 'ai_agent', 'forward', 'hangup'];
export const MENU_CHOICE_ACTIONS: MenuChoiceAction[] = ['agents', 'voicemail', 'ai_agent', 'forward'];
export const MAX_MENU_CHOICES = 9;

// Mirror DESK_PHONE_DEFAULT_RING_SECONDS / DESK_PHONE_DEFAULT_MAX_WAIT_SECONDS in
// packages/core/db/src/schema/desk-phone-routes.ts (kept out of the SPA bundle).
export const DEFAULT_RING_SECONDS = 25;
export const DEFAULT_MAX_WAIT_SECONDS = 300;
export const DEFAULT_LANGUAGE = 'en-US';
export const COMMON_LANGUAGES = ['en-US', 'en-GB', 'nl-NL', 'nl-BE', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'pt-PT'] as const;

export interface MenuChoiceValues {
  /** Identifies the row in the editor, so removing another row never reuses its inputs. Not sent. */
  uid: string;
  digit: MenuDigit;
  label: string;
  action: MenuChoiceAction;
  voiceAgentId: string;
  /** A team id; empty rings every available agent. */
  departmentId: string;
  forwardToE164: string;
}

export interface PhoneRouteFormValues {
  action: DeskPhoneRouteAction;
  voiceAgentId: string;
  forwardToE164: string;
  greeting: string;
  language: string;
  /** A team id; empty rings every available agent. */
  departmentId: string;
  ringSeconds: number | undefined;
  maxWaitSeconds: number | undefined;
  whenUnanswered: UnansweredAction;
  voicemailGreeting: string;
  menuPrompt: string;
  menuChoices: MenuChoiceValues[];
  /** One of the choices' digits; empty hangs up. */
  fallbackDigit: MenuDigit | '';
}

export type FieldErrorCode =
  | 'required'
  | 'tooLong'
  | 'e164'
  | 'ringRange'
  | 'maxWaitRange'
  | 'digitUsed'
  | 'fallbackInvalid'
  | 'choicesRange'
  | 'languageInvalid'
  | 'invalid';

/** A message from the client check (a code the editor translates) or from the server (shown as is). */
export type FieldError = { code: FieldErrorCode } | { message: string };
export type FormErrors = Record<string, FieldError>;

let choiceCounter = 0;
const nextChoiceUid = () => `choice-${++choiceCounter}`;

export function emptyChoice(digit: MenuDigit): MenuChoiceValues {
  return { uid: nextChoiceUid(), digit, label: '', action: 'agents', voiceAgentId: '', departmentId: '', forwardToE164: '' };
}

/** The digits no choice uses yet, in keypad order. */
export function unusedDigits(choices: ReadonlyArray<Pick<MenuChoiceValues, 'digit'>>): MenuDigit[] {
  const used = new Set(choices.map((c) => c.digit));
  return DESK_PHONE_MENU_DIGITS.filter((d) => !used.has(d));
}

export function emptyRouteValues(): PhoneRouteFormValues {
  return {
    action: 'hangup',
    voiceAgentId: '',
    forwardToE164: '',
    greeting: '',
    language: DEFAULT_LANGUAGE,
    departmentId: '',
    ringSeconds: DEFAULT_RING_SECONDS,
    maxWaitSeconds: DEFAULT_MAX_WAIT_SECONDS,
    whenUnanswered: 'voicemail',
    voicemailGreeting: '',
    menuPrompt: '',
    menuChoices: [],
    fallbackDigit: '',
  };
}

/** The form for a number: its stored route, or a fresh one (hang up) when it has none. */
export function routeToValues(route: DeskPhoneRoute | undefined): PhoneRouteFormValues {
  const base = emptyRouteValues();
  if (!route) return base;
  const o = route.options ?? {};
  return {
    ...base,
    action: route.action,
    voiceAgentId: route.voiceAgentId ?? '',
    forwardToE164: route.forwardToE164 ?? '',
    greeting: o.greeting ?? '',
    language: o.language ?? DEFAULT_LANGUAGE,
    departmentId: o.departmentId ?? '',
    ringSeconds: o.ringSeconds ?? DEFAULT_RING_SECONDS,
    maxWaitSeconds: o.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS,
    whenUnanswered: o.whenUnanswered ?? 'voicemail',
    voicemailGreeting: o.voicemailGreeting ?? '',
    menuPrompt: o.menu?.prompt ?? '',
    menuChoices: (o.menu?.choices ?? []).map((c) => ({
      uid: nextChoiceUid(),
      digit: c.digit,
      label: c.label ?? '',
      action: c.action,
      voiceAgentId: c.voiceAgentId ?? '',
      departmentId: c.departmentId ?? '',
      forwardToE164: c.forwardToE164 ?? '',
    })),
    fallbackDigit: o.menu?.fallbackDigit ?? '',
  };
}

/** Whether the unanswered action runs: ring agents, or a keypad choice that rings agents. */
export function usesQueue(values: Pick<PhoneRouteFormValues, 'action' | 'menuChoices'>): boolean {
  return (
    values.action === 'agents' || (values.action === 'menu' && values.menuChoices.some((c) => c.action === 'agents'))
  );
}

/** Whether a voicemail can be left: a voicemail route, a voicemail choice, or "when nobody answers" = voicemail. */
export function usesVoicemail(values: PhoneRouteFormValues): boolean {
  if (values.action === 'voicemail') return true;
  if (values.action === 'agents') return values.whenUnanswered === 'voicemail';
  if (values.action === 'menu') {
    return (
      values.menuChoices.some((c) => c.action === 'voicemail') ||
      (usesQueue(values) && values.whenUnanswered === 'voicemail')
    );
  }
  return false;
}

function options(values: PhoneRouteFormValues): DeskPhoneRouteOptionsInput | null {
  const trimmed = (s: string) => s.trim();
  const out: DeskPhoneRouteOptionsInput = {};
  const queue = usesQueue(values);
  const voicemail = usesVoicemail(values);
  if (values.action === 'agents') {
    if (trimmed(values.greeting)) out.greeting = trimmed(values.greeting);
    if (values.departmentId) out.departmentId = values.departmentId;
  }
  out.language = values.language.trim() || DEFAULT_LANGUAGE;
  if (queue) {
    if (values.ringSeconds !== undefined) out.ringSeconds = values.ringSeconds;
    if (values.maxWaitSeconds !== undefined) out.maxWaitSeconds = values.maxWaitSeconds;
    out.whenUnanswered = values.whenUnanswered;
  }
  if (voicemail && trimmed(values.voicemailGreeting)) out.voicemailGreeting = trimmed(values.voicemailGreeting);
  if (values.action === 'menu') {
    out.menu = {
      prompt: trimmed(values.menuPrompt),
      choices: values.menuChoices.map((c) => ({
        digit: c.digit,
        ...(trimmed(c.label) ? { label: trimmed(c.label) } : {}),
        action: c.action,
        ...(c.action === 'ai_agent' ? { voiceAgentId: c.voiceAgentId } : {}),
        ...(c.action === 'agents' && c.departmentId ? { departmentId: c.departmentId } : {}),
        ...(c.action === 'forward' ? { forwardToE164: c.forwardToE164.trim() } : {}),
      })),
      ...(values.fallbackDigit ? { fallbackDigit: values.fallbackDigit } : {}),
    };
  }
  return out;
}

/** The request body for a number: only what the chosen action uses. */
export function valuesToInput(voipPhoneNumberId: string, values: PhoneRouteFormValues): UpsertDeskPhoneRoute {
  switch (values.action) {
    case 'ai_agent':
      return { voipPhoneNumberId, action: 'ai_agent', voiceAgentId: values.voiceAgentId };
    case 'forward':
      return { voipPhoneNumberId, action: 'forward', forwardToE164: values.forwardToE164.trim() };
    case 'hangup':
      return { voipPhoneNumberId, action: 'hangup' };
    default:
      return { voipPhoneNumberId, action: values.action, options: options(values) };
  }
}

type PathSegment = string | number;

const SIMPLE_KEYS = new Set([
  'greeting',
  'language',
  'departmentId',
  'ringSeconds',
  'maxWaitSeconds',
  'voicemailGreeting',
]);

/** The form field a Zod issue path (from the shared schema, or from the server) points at. */
export function pathToField(path: ReadonlyArray<PathSegment>): string | null {
  const [first, second, third, fourth, fifth] = path;
  if (first === 'voiceAgentId' || first === 'forwardToE164') return first;
  if (first !== 'options' || typeof second !== 'string') return null;
  if (SIMPLE_KEYS.has(second)) return second;
  if (second === 'whenUnanswered') return 'whenUnanswered';
  if (second !== 'menu') return null;
  if (third === 'prompt') return 'menuPrompt';
  if (third === 'fallbackDigit') return 'fallbackDigit';
  if (third === 'choices' && fourth === undefined) return 'menuChoices';
  if (third === 'choices' && typeof fourth === 'number' && typeof fifth === 'string') return `choice.${fourth}.${fifth}`;
  return 'menuChoices';
}

function codeFor(field: string, issueCode: string): FieldErrorCode {
  const leaf = field.startsWith('choice.') ? (field.split('.')[2] ?? '') : field;
  switch (leaf) {
    case 'ringSeconds':
      return 'ringRange';
    case 'maxWaitSeconds':
      return 'maxWaitRange';
    case 'digit':
      return 'digitUsed';
    case 'fallbackDigit':
      return 'fallbackInvalid';
    case 'menuChoices':
      return 'choicesRange';
    case 'language':
      return 'languageInvalid';
    case 'forwardToE164':
      return 'e164';
    case 'voiceAgentId':
      return 'required';
    case 'menuPrompt':
      return issueCode === 'too_big' ? 'tooLong' : 'required';
    case 'greeting':
    case 'voicemailGreeting':
    case 'label':
      return 'tooLong';
    default:
      return 'invalid';
  }
}

/** Run the shared schema; the first problem of each field, keyed by field. Empty when the body is valid. */
export function validateInput(input: UpsertDeskPhoneRoute): FormErrors {
  const parsed = upsertDeskPhoneRouteSchema.safeParse(input);
  if (parsed.success) return {};
  const errors: FormErrors = {};
  for (const issue of parsed.error.issues) {
    const field = pathToField(issue.path);
    if (field && !errors[field]) errors[field] = { code: codeFor(field, issue.code) };
  }
  return errors;
}

/** Check the form: the schema's rules, plus the picks the schema cannot know about. */
export function validateValues(voipPhoneNumberId: string, values: PhoneRouteFormValues): FormErrors {
  return validateInput(valuesToInput(voipPhoneNumberId, values));
}

/**
 * Map a failed save onto the form. `status` and `body` come from the
 * `ApiError`; `message` is its text. Validation answers carry Zod issues with
 * paths; a 404 names the team or voice agent in its message, a 400 can say a
 * voice agent is disabled. Anything else has no field and goes to `form`.
 */
export function serverErrorToFormErrors(
  values: PhoneRouteFormValues,
  failure: { status?: number; body?: unknown; message: string },
): FormErrors {
  const errors: FormErrors = {};
  const issues = extractIssues(failure.body);
  for (const issue of issues) {
    const field = pathToField(issue.path);
    if (field && !errors[field]) errors[field] = { message: issue.message };
  }
  if (Object.keys(errors).length > 0) return errors;

  const quoted = /ID '([^']+)' not found/.exec(failure.message)?.[1];
  const disabled = /Voice agent (\S+) is disabled/.exec(failure.message)?.[1];
  const entity = /^(Team|Voice agent) with ID/.exec(failure.message)?.[1];
  const id = quoted ?? disabled;
  if (id) {
    const wantsTeam = entity === 'Team';
    const wantsAgent = entity === 'Voice agent' || disabled !== undefined;
    const message = { message: failure.message };
    if (wantsAgent && values.voiceAgentId === id && values.action === 'ai_agent') errors.voiceAgentId = message;
    if (wantsTeam && values.action === 'agents' && values.departmentId === id) errors.departmentId = message;
    if (values.action === 'menu') {
      values.menuChoices.forEach((choice, index) => {
        if (wantsAgent && choice.action === 'ai_agent' && choice.voiceAgentId === id) errors[`choice.${index}.voiceAgentId`] = message;
        if (wantsTeam && choice.action === 'agents' && choice.departmentId === id) errors[`choice.${index}.departmentId`] = message;
      });
    }
  }
  if (Object.keys(errors).length === 0) errors.form = { message: failure.message };
  return errors;
}

/** Where a failed response keeps its issues: on the body itself, or under `error`. */
function issuesHolder(root: { issues?: unknown; error?: unknown }): { issues?: unknown } | null {
  if (Array.isArray(root.issues)) return root;
  return typeof root.error === 'object' && root.error !== null ? (root.error as { issues?: unknown }) : null;
}

function extractIssues(body: unknown): Array<{ path: PathSegment[]; message: string }> {
  if (typeof body !== 'object' || body === null) return [];
  const holder = issuesHolder(body as { issues?: unknown; error?: unknown });
  if (!holder || !Array.isArray(holder.issues)) return [];
  const out: Array<{ path: PathSegment[]; message: string }> = [];
  for (const raw of holder.issues) {
    if (typeof raw !== 'object' || raw === null) continue;
    const { path, message } = raw as { path?: unknown; message?: unknown };
    if (!Array.isArray(path) || typeof message !== 'string') continue;
    out.push({ path: path.filter((p): p is PathSegment => typeof p === 'string' || typeof p === 'number'), message });
  }
  return out;
}
