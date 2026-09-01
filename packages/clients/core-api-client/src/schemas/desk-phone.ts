import { z } from 'zod';

export const DESK_PHONE_ROUTE_ACTIONS = ['ai_agent', 'forward', 'hangup'] as const;

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

export const upsertDeskPhoneRouteSchema = z.object({
  voipPhoneNumberId: z.string().min(1),
  action: z.enum(DESK_PHONE_ROUTE_ACTIONS),
  voiceAgentId: z.string().nullable().optional(),
  forwardToE164: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/, 'Must be E.164')
    .nullable()
    .optional(),
}).superRefine((data, ctx) => {
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

export type CreateDeskVoiceAgent = z.infer<typeof createDeskVoiceAgentSchema>;
export type UpdateDeskVoiceAgent = z.infer<typeof updateDeskVoiceAgentSchema>;
export type UpsertDeskPhoneRoute = z.infer<typeof upsertDeskPhoneRouteSchema>;
