/**
 * Workspace AI settings (Kubernetes editions, plan weldsuite-documentation/plans/eu-ai-mistral.md):
 * the effective policy, own provider keys and usage. `GET /api/ai-settings` is
 * also the source of every model picker on those installs, so the hooks are
 * disabled where `/config.json` has no `ai` block (Global has no such route).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { hasAiSettings } from '@/lib/edition';
import type {
  AiFeatureState,
  AiModelOption,
  AiSettings,
  UpdateAiSettingsInput,
} from '@weldsuite/app-api-client/schemas/ai-settings';

export const aiSettingsKeys = {
  all: ['ai-settings'] as const,
  policy: () => [...aiSettingsKeys.all, 'policy'] as const,
  usage: () => [...aiSettingsKeys.all, 'usage'] as const,
};

/** The effective AI policy. Disabled (and never requested) when this install has no AI settings. */
export function useAiSettings(enabled = true) {
  const { aiSettings } = useAppApi();
  return useQuery({
    queryKey: aiSettingsKeys.policy(),
    queryFn: () => aiSettings.get(),
    select: (res) => res.data,
    enabled: enabled && hasAiSettings(),
    staleTime: 60_000,
  });
}

/** One feature's state: its effective provider and the models it may use. */
export function useAiFeature(featureId: string, enabled = true) {
  const query = useAiSettings(enabled);
  const feature: AiFeatureState | undefined = query.data?.features.find((f) => f.id === featureId);
  return { ...query, feature };
}

/**
 * The models to offer in a picker for a feature, or null when the install has
 * no AI settings (Global keeps its own lists) or the policy has not loaded.
 */
export function useAiModelOptions(featureId: string): AiModelOption[] | null {
  const { feature } = useAiFeature(featureId);
  return feature ? feature.models : null;
}

/** Credits and tokens per provider and feature (`ai:manage`). */
export function useAiUsage(enabled = true) {
  const { aiSettings } = useAppApi();
  return useQuery({
    queryKey: aiSettingsKeys.usage(),
    queryFn: () => aiSettings.usage(),
    select: (res) => res.data,
    enabled: enabled && hasAiSettings(),
  });
}

/** Providers, default provider and feature overrides. The answer is the new policy. */
export function useUpdateAiSettings() {
  const { aiSettings } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAiSettingsInput) => aiSettings.update(input),
    onSuccess: (res) => {
      qc.setQueryData(aiSettingsKeys.policy(), res);
    },
  });
}

/** Store and check an own key; the policy (key status) is refetched on success. */
export function useSetAiKey() {
  const { aiSettings } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, apiKey }: { provider: string; apiKey: string }) => aiSettings.setKey(provider, { apiKey }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: aiSettingsKeys.policy() });
    },
  });
}

export function useTestAiKey() {
  const { aiSettings } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (provider: string) => aiSettings.testKey(provider),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: aiSettingsKeys.policy() });
    },
  });
}

export function useRemoveAiKey() {
  const { aiSettings } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (provider: string) => aiSettings.removeKey(provider),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: aiSettingsKeys.policy() });
    },
  });
}

export type { AiSettings };
