/**
 * App-API AI settings domain client: `/api/ai-settings/*` (Rust backend, the
 * Kubernetes editions; plan weldsuite-documentation/plans/eu-ai-mistral.md).
 */

import type { ClientApi, DataResponse } from '../types';
import type { AiKeyStatus, AiSettings, AiUsage, SetAiKeyInput, UpdateAiSettingsInput } from '../schemas/ai-settings';

export function createAiSettingsApi(api: ClientApi) {
  return {
    /** The effective policy: providers, default, per-feature state and allowed models. */
    get(): Promise<DataResponse<AiSettings>> {
      return api.get<DataResponse<AiSettings>>('/ai-settings');
    },

    /** Providers, default provider and feature overrides (`ai:manage`). */
    update(input: UpdateAiSettingsInput): Promise<DataResponse<AiSettings>> {
      return api.put<DataResponse<AiSettings>>('/ai-settings', input);
    },

    /** Store a workspace's own key. The key is checked first (422 when it fails). */
    setKey(provider: string, input: SetAiKeyInput): Promise<DataResponse<AiKeyStatus>> {
      return api.put<DataResponse<AiKeyStatus>>(`/ai-settings/keys/${encodeURIComponent(provider)}`, input);
    },

    /** Check the stored key again. */
    testKey(provider: string): Promise<DataResponse<AiKeyStatus>> {
      return api.post<DataResponse<AiKeyStatus>>(`/ai-settings/keys/${encodeURIComponent(provider)}/test`, {});
    },

    removeKey(provider: string): Promise<void> {
      return api.delete<void>(`/ai-settings/keys/${encodeURIComponent(provider)}`);
    },

    /** Credits and tokens per provider and feature, this month and last (`ai:manage`). */
    usage(): Promise<DataResponse<AiUsage>> {
      return api.get<DataResponse<AiUsage>>('/ai-settings/usage');
    },
  };
}

export type AiSettingsApi = ReturnType<typeof createAiSettingsApi>;
