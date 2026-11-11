import { z } from 'zod';

// These lists mirror packages/core/db/src/schema/desk-phone-routes.ts (this
// package does not depend on @weldsuite/db); call-api's desk-phone test checks
// they stay equal.
export const DESK_PHONE_ROUTE_ACTIONS = ['ai_agent', 'forward', 'hangup', 'agents', 'voicemail', 'menu'] as const;
export type DeskPhoneRouteAction = (typeof DESK_PHONE_ROUTE_ACTIONS)[number];
/** What a keypad choice can do. */
export const DESK_PHONE_MENU_ACTIONS = ['ai_agent', 'agents', 'forward', 'voicemail'] as const;
export const DESK_PHONE_MENU_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'] as const;
export const DESK_PHONE_UNANSWERED_ACTIONS = ['voicemail', 'hangup'] as const;

export const DESK_PHONE_RING_SECONDS_RANGE = { min: 10, max: 60 } as const;
export const DESK_PHONE_MAX_WAIT_SECONDS_RANGE = { min: 30, max: 1800 } as const;
export const DESK_PHONE_TEXT_MAX_LENGTH = 1000;

export const deskVoiceAgentSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  name: z.string(),
  systemPrompt: z.string(),
  greeting: z.string().nullable().optional(),
  telnyxAssistantId: z.string().nullable().optional(),
  enabled: z.boolean(),
  forwardToE164: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  voice: z.string().nullable().optional(),
});

export const createDeskVoiceAgentSchema = z.object({
  name: z.string().min(1).max(255),
  systemPrompt: z.string().min(1),
  greeting: z.string().max(2000).nullable().optional(),
  enabled: z.boolean().optional().default(true),
  forwardToE164: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/, 'Must be E.164')
    .nullable()
    .optional(),
  model: z.string().max(100).nullable().optional(),
  voice: z.string().max(100).nullable().optional(),
});

export const updateDeskVoiceAgentSchema = createDeskVoiceAgentSchema.partial();

const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'Must be E.164');
const spokenText = z.string().trim().max(DESK_PHONE_TEXT_MAX_LENGTH);
/** A BCP 47 tag such as `en-US` or `nl-NL`. */
const bcp47 = z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Must be a BCP 47 language tag');

export const deskPhoneMenuChoiceSchema = z
  .object({
    digit: z.enum(DESK_PHONE_MENU_DIGITS),
    label: z.string().trim().max(100).optional(),
    action: z.enum(DESK_PHONE_MENU_ACTIONS),
    voiceAgentId: z.string().min(1).nullish().transform((v) => v ?? undefined),
    departmentId: z.string().min(1).nullable().optional(),
    forwardToE164: e164.nullish().transform((v) => v ?? undefined),
  })
  .superRefine((choice, ctx) => {
    if (choice.action === 'ai_agent' && !choice.voiceAgentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'voiceAgentId is required for ai_agent choices', path: ['voiceAgentId'] });
    }
    if (choice.action === 'forward' && !choice.forwardToE164) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'forwardToE164 is required for forward choices', path: ['forwardToE164'] });
    }
  });

export const deskPhoneMenuSchema = z
  .object({
    prompt: spokenText.min(1),
    choices: z.array(deskPhoneMenuChoiceSchema).min(1).max(9),
    fallbackDigit: z.enum(DESK_PHONE_MENU_DIGITS).nullable().optional(),
  })
  .superRefine((menu, ctx) => {
    const seen = new Set<string>();
    menu.choices.forEach((choice, index) => {
      if (seen.has(choice.digit)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Digit ${choice.digit} is used twice`, path: ['choices', index, 'digit'] });
      }
      seen.add(choice.digit);
    });
    if (menu.fallbackDigit && !seen.has(menu.fallbackDigit)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'fallbackDigit must be one of the choices', path: ['fallbackDigit'] });
    }
  });

export const deskPhoneRouteOptionsSchema = z.object({
  greeting: spokenText.optional(),
  language: bcp47.optional(),
  departmentId: z.string().min(1).nullable().optional(),
  ringSeconds: z
    .number()
    .int()
    .min(DESK_PHONE_RING_SECONDS_RANGE.min)
    .max(DESK_PHONE_RING_SECONDS_RANGE.max)
    .optional(),
  maxWaitSeconds: z
    .number()
    .int()
    .min(DESK_PHONE_MAX_WAIT_SECONDS_RANGE.min)
    .max(DESK_PHONE_MAX_WAIT_SECONDS_RANGE.max)
    .optional(),
  whenUnanswered: z.enum(DESK_PHONE_UNANSWERED_ACTIONS).optional(),
  voicemailGreeting: spokenText.optional(),
  menu: deskPhoneMenuSchema.optional(),
});

export type DeskPhoneRouteOptionsInput = z.infer<typeof deskPhoneRouteOptionsSchema>;
export type DeskPhoneMenuChoiceInput = z.infer<typeof deskPhoneMenuChoiceSchema>;

/**
 * Which options each action uses; the rest are dropped on write:
 *   agents:    greeting, language, departmentId, ringSeconds, maxWaitSeconds, whenUnanswered, voicemailGreeting
 *   voicemail: language, voicemailGreeting
 *   menu:      language, menu, and ringSeconds, maxWaitSeconds, whenUnanswered, voicemailGreeting
 *              (used by its `agents` and `voicemail` choices)
 *   ai_agent, forward, hangup: none (options is stored as null)
 */
const OPTION_KEYS_BY_ACTION: Record<DeskPhoneRouteAction, ReadonlyArray<keyof DeskPhoneRouteOptionsInput>> = {
  agents: ['greeting', 'language', 'departmentId', 'ringSeconds', 'maxWaitSeconds', 'whenUnanswered', 'voicemailGreeting'],
  voicemail: ['language', 'voicemailGreeting'],
  menu: ['language', 'menu', 'ringSeconds', 'maxWaitSeconds', 'whenUnanswered', 'voicemailGreeting'],
  ai_agent: [],
  forward: [],
  hangup: [],
};

/** A menu choice with only the fields its action uses. */
function normalizeMenuChoice(choice: DeskPhoneMenuChoiceInput): DeskPhoneMenuChoiceInput {
  const label = choice.label?.trim();
  return {
    digit: choice.digit,
    ...(label ? { label } : {}),
    action: choice.action,
    ...(choice.action === 'ai_agent' && choice.voiceAgentId ? { voiceAgentId: choice.voiceAgentId } : {}),
    ...(choice.action === 'agents' && choice.departmentId ? { departmentId: choice.departmentId } : {}),
    ...(choice.action === 'forward' && choice.forwardToE164 ? { forwardToE164: choice.forwardToE164 } : {}),
  };
}

/** The stored form of a menu: every choice cut down to its own fields, a null fallback left out. */
function normalizeMenu(menu: NonNullable<DeskPhoneRouteOptionsInput['menu']>): NonNullable<DeskPhoneRouteOptionsInput['menu']> {
  return {
    prompt: menu.prompt,
    choices: menu.choices.map(normalizeMenuChoice),
    ...(menu.fallbackDigit ? { fallbackDigit: menu.fallbackDigit } : {}),
  };
}

/** The options `action` uses, as given; one it does not use reads as undefined. */
function usedOptions(action: DeskPhoneRouteAction, options: DeskPhoneRouteOptionsInput): DeskPhoneRouteOptionsInput {
  const keep = new Set(OPTION_KEYS_BY_ACTION[action]);
  const use = <K extends keyof DeskPhoneRouteOptionsInput>(key: K): DeskPhoneRouteOptionsInput[K] | undefined =>
    keep.has(key) ? options[key] : undefined;
  return {
    greeting: use('greeting'),
    language: use('language'),
    departmentId: use('departmentId'),
    ringSeconds: use('ringSeconds'),
    maxWaitSeconds: use('maxWaitSeconds'),
    whenUnanswered: use('whenUnanswered'),
    voicemailGreeting: use('voicemailGreeting'),
    menu: use('menu'),
  };
}

/**
 * The options as they are stored for `action`: options the action does not
 * use are dropped, empty texts and nulls omitted, menu choices cut down to
 * their own fields. Null when nothing is left.
 */
export function normalizeDeskPhoneRouteOptions(
  action: DeskPhoneRouteAction,
  options: DeskPhoneRouteOptionsInput | null | undefined,
): DeskPhoneRouteOptionsInput | null {
  if (!options) return null;
  const used = usedOptions(action, options);
  const out: DeskPhoneRouteOptionsInput = {};
  if (used.greeting) out.greeting = used.greeting;
  if (used.language) out.language = used.language;
  if (used.departmentId) out.departmentId = used.departmentId;
  if (used.ringSeconds !== undefined) out.ringSeconds = used.ringSeconds;
  if (used.maxWaitSeconds !== undefined) out.maxWaitSeconds = used.maxWaitSeconds;
  if (used.whenUnanswered) out.whenUnanswered = used.whenUnanswered;
  if (used.voicemailGreeting) out.voicemailGreeting = used.voicemailGreeting;
  if (used.menu) out.menu = normalizeMenu(used.menu);
  return Object.keys(out).length > 0 ? out : null;
}

export const upsertDeskPhoneRouteSchema = z.object({
  voipPhoneNumberId: z.string().min(1),
  action: z.enum(DESK_PHONE_ROUTE_ACTIONS),
  voiceAgentId: z.string().nullable().optional(),
  forwardToE164: e164.nullable().optional(),
  options: deskPhoneRouteOptionsSchema.nullable().optional(),
}).superRefine((data, ctx) => {
  if (data.action === 'menu' && !data.options?.menu) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'options.menu is required for menu routes',
      path: ['options', 'menu'],
    });
  }
  if (data.action === 'ai_agent' && !data.voiceAgentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'voiceAgentId is required for ai_agent routes',
      path: ['voiceAgentId'],
    });
  }
  if (data.action === 'forward' && !data.forwardToE164) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'forwardToE164 is required for forward routes',
      path: ['forwardToE164'],
    });
  }
});

/** PUT /api/desk/phone/softphone: the member's own "take calls" switch. */
export const updateDeskSoftphoneSchema = z.object({ available: z.boolean() });

export type UpdateDeskSoftphone = z.infer<typeof updateDeskSoftphoneSchema>;
export type CreateDeskVoiceAgent = z.infer<typeof createDeskVoiceAgentSchema>;
export type UpdateDeskVoiceAgent = z.infer<typeof updateDeskVoiceAgentSchema>;
export type UpsertDeskPhoneRoute = z.infer<typeof upsertDeskPhoneRouteSchema>;
