/**
 * Workspace AI settings (`/api/ai-settings`, plan weldsuite-documentation/plans/eu-ai-mistral.md,
 * ADR AI-012): which AI providers a workspace allows, where each feature runs
 * and what has been spent. Served by the Rust backend on the Kubernetes
 * editions only; Global does not offer the route. Zod v3, shared by the
 * platform and the Rust route tests' fixtures.
 */

import { z } from 'zod';

export const AI_PROVIDER_IDS = ['mistral', 'anthropic', 'openai', 'compat'] as const;
export const aiProviderIdSchema = z.enum(AI_PROVIDER_IDS);
export type AiProviderId = z.infer<typeof aiProviderIdSchema>;

/** The providers a workspace can switch on or off itself (the install default is always on). */
export const AI_OPT_IN_PROVIDER_IDS = ['anthropic', 'openai'] as const;
export type AiOptInProviderId = (typeof AI_OPT_IN_PROVIDER_IDS)[number];

export const aiRegionSchema = z.enum(['eu', 'outside-eu']);
export type AiRegion = z.infer<typeof aiRegionSchema>;

export const aiKeySourceSchema = z.enum(['weldsuite', 'own']);
export type AiKeySource = z.infer<typeof aiKeySourceSchema>;

/** What the response of an AI call says about who answered (`meta.ai`). */
export const aiMetaSchema = z.object({
  provider: aiProviderIdSchema,
  model: z.string(),
  region: aiRegionSchema,
});
export type AiMeta = z.infer<typeof aiMetaSchema>;

/** A key's last check. Only `ai:manage` members receive it. */
export const aiKeyStatusSchema = z.object({
  /** `sk-…a1b2`: never the key itself. */
  hint: z.string(),
  status: z.enum(['ok', 'failing']),
  lastError: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
});
export type AiKeyStatus = z.infer<typeof aiKeyStatusSchema>;

export const aiProviderStateSchema = z.object({
  id: aiProviderIdSchema,
  region: aiRegionSchema,
  /** The install's default provider (always on). */
  install: z.boolean(),
  /** The install has what this provider needs (a key of WeldSuite's, or own keys allowed). */
  offered: z.boolean(),
  enabled: z.boolean(),
  keySource: aiKeySourceSchema.nullable(),
  /** The key sources the install allows for this provider. */
  keySources: z.array(aiKeySourceSchema),
  enabledBy: z.string().nullable().optional(),
  enabledAt: z.string().nullable().optional(),
  key: aiKeyStatusSchema.nullable().optional(),
});
export type AiProviderState = z.infer<typeof aiProviderStateSchema>;

export const aiModelOptionSchema = z.object({
  /** Canonical id with the provider prefix (`anthropic/claude-sonnet-5-5`). */
  id: z.string(),
  provider: aiProviderIdSchema,
  region: aiRegionSchema,
  label: z.string(),
});
export type AiModelOption = z.infer<typeof aiModelOptionSchema>;

export const aiFeatureOverrideSchema = z.object({
  provider: aiProviderIdSchema,
  model: z.string().nullable().optional(),
});
export type AiFeatureOverride = z.infer<typeof aiFeatureOverrideSchema>;

export const aiFeatureStateSchema = z.object({
  /** Catalog id: `mail`, `connect`, `search-index`, … */
  id: z.string(),
  /** False for features WeldSuite fixes (the search index). */
  overridable: z.boolean(),
  override: aiFeatureOverrideSchema.nullable(),
  effective: aiMetaSchema,
  /** The models this workspace may pick for this feature. */
  models: z.array(aiModelOptionSchema),
});
export type AiFeatureState = z.infer<typeof aiFeatureStateSchema>;

export const aiSettingsSchema = z.object({
  installProvider: aiProviderIdSchema,
  defaultProvider: aiProviderIdSchema,
  providers: z.array(aiProviderStateSchema),
  features: z.array(aiFeatureStateSchema),
  canManage: z.boolean(),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;

export const updateAiSettingsSchema = z.object({
  providers: z
    .object({
      anthropic: z.object({ enabled: z.boolean(), keySource: aiKeySourceSchema }).optional(),
      openai: z.object({ enabled: z.boolean(), keySource: aiKeySourceSchema }).optional(),
    })
    .optional(),
  defaultProvider: aiProviderIdSchema.nullable().optional(),
  featureOverrides: z.record(aiFeatureOverrideSchema.nullable()).optional(),
  /** Required (true) when this change enables a provider outside the EU. */
  acknowledgedOutsideEu: z.boolean().optional(),
});
export type UpdateAiSettingsInput = z.infer<typeof updateAiSettingsSchema>;

export const setAiKeySchema = z.object({
  apiKey: z.string().trim().min(8).max(512),
});
export type SetAiKeyInput = z.infer<typeof setAiKeySchema>;

export const aiUsageSchema = z.object({
  months: z.array(
    z.object({
      /** `YYYY-MM`, the current month first. */
      month: z.string(),
      byProvider: z.array(
        z.object({
          provider: aiProviderIdSchema,
          credits: z.number(),
          inputTokens: z.number(),
          outputTokens: z.number(),
          keySource: aiKeySourceSchema,
        }),
      ),
      byFeature: z.array(z.object({ feature: z.string(), credits: z.number() })),
    }),
  ),
});
export type AiUsage = z.infer<typeof aiUsageSchema>;

/** The `ai` block of `/config.json` (a Kubernetes install with AI configured). */
export const runtimeAiConfigSchema = z.object({
  defaultProvider: aiProviderIdSchema,
  providers: z.array(
    z.object({
      id: aiProviderIdSchema,
      region: aiRegionSchema,
      keySources: z.array(aiKeySourceSchema),
    }),
  ),
});
export type RuntimeAiConfig = z.infer<typeof runtimeAiConfigSchema>;
