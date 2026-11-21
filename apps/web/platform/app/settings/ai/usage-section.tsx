import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SettingsSection } from '@weldsuite/ui/components/settings-layout';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { useAiProviderName } from '@/components/ai/ai-meta-badge';
import { useAiUsage } from '@/hooks/queries/use-ai-settings-queries';
import { useI18n } from '@/lib/i18n/provider';

/** Credits per provider and feature, and the tokens of own-key calls, this month and last. */
export function UsageSection() {
  const { t } = useI18n();
  const ta = t.settings.ai;
  const providerName = useAiProviderName();
  const { data, isLoading } = useAiUsage();
  const number = (n: number) => n.toLocaleString();
  const months = data?.months ?? [];
  const empty = months.every((m) => m.byProvider.length === 0 && m.byFeature.length === 0);

  return (
    <SettingsSection title={ta.usage.title} description={ta.usage.description}>
      {isLoading && <InlineSpinner />}
      {!isLoading && empty && <EmptyText>{ta.usage.empty}</EmptyText>}
      {!isLoading &&
        !empty &&
        months.map((month, index) => (
          <div key={month.month} className="space-y-3 rounded-xl border p-4" data-testid={`ai-usage-${month.month}`}>
            <h3 className="text-sm font-medium">
              {index === 0 ? ta.usage.thisMonth : ta.usage.lastMonth}
              <span className="ml-2 font-normal text-muted-foreground">{month.month}</span>
            </h3>
            {month.byProvider.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {ta.usage.byProvider}
                </p>
                <ul className="divide-y">
                  {month.byProvider.map((row) => (
                    <li
                      key={`${row.provider}-${row.keySource}`}
                      className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm"
                    >
                      <span className="flex items-center gap-2">
                        {providerName(row.provider)}
                        <SoftBadge tone="neutral">
                          {row.keySource === 'own' ? ta.usage.ownKey : ta.usage.weldsuiteKey}
                        </SoftBadge>
                      </span>
                      <span className="text-muted-foreground">
                        {row.keySource === 'own'
                          ? ta.usage.tokens
                              .replace('{input}', number(row.inputTokens))
                              .replace('{output}', number(row.outputTokens))
                          : ta.usage.credits.replace('{count}', number(row.credits))}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {month.byFeature.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {ta.usage.byFeature}
                </p>
                <ul className="divide-y">
                  {month.byFeature.map((row) => (
                    <li key={row.feature} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                      <span>{(ta.features.names as Record<string, string>)[row.feature] ?? row.feature}</span>
                      <span className="text-muted-foreground">
                        {ta.usage.credits.replace('{count}', number(row.credits))}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
    </SettingsSection>
  );
}
