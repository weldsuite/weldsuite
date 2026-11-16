import { AiProviderBadge } from '@weldsuite/ui/components/ai-provider-badge';
import type { AiMeta, AiProviderId, AiRegion } from '@weldsuite/app-api-client/schemas/ai-settings';
import { useI18n } from '@/lib/i18n/provider';

/** The people-facing name of a provider ("Claude" for `anthropic`). */
export function useAiProviderName(): (provider: AiProviderId | string) => string {
  const { t } = useI18n();
  const names = t.settings.ai.names as Record<string, string>;
  return (provider) => names[provider] ?? provider;
}

/**
 * "Claude · outside the EU": which provider answered and where it processes
 * data (`meta.ai` of an AI response, or a model of `GET /api/ai-settings`).
 * Renders nothing without a provider, so Global's responses (no `meta.ai`)
 * show no badge.
 */
export function AiMetaBadge({
  ai,
  className,
  hideIcon,
}: Readonly<{
  ai: Pick<AiMeta, 'provider' | 'region'> | null | undefined;
  className?: string;
  hideIcon?: boolean;
}>) {
  const { t } = useI18n();
  const providerName = useAiProviderName();
  if (!ai) return null;
  const regionLabel = (ai.region satisfies AiRegion) === 'eu' ? t.settings.ai.badge.eu : t.settings.ai.badge.outsideEu;
  return (
    <AiProviderBadge
      provider={providerName(ai.provider)}
      region={ai.region}
      regionLabel={regionLabel}
      className={className}
      hideIcon={hideIcon}
    />
  );
}

/** The `meta.ai` of a JSON response body, when the backend sent one. */
export function readAiMeta(body: unknown): AiMeta | null {
  if (!body || typeof body !== 'object') return null;
  const meta = (body as { meta?: { ai?: AiMeta } }).meta;
  const ai = meta?.ai;
  return ai && typeof ai.provider === 'string' && (ai.region === 'eu' || ai.region === 'outside-eu') ? ai : null;
}
