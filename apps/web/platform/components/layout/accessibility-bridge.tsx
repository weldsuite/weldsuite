import { useEffect, useMemo, type ReactNode } from 'react';
import { UiLabelsProvider, type UiLabels } from '@weldsuite/ui/providers/ui-labels-provider';
import { useI18n } from '@/lib/i18n/provider';

/**
 * Keeps `<html lang>` on the active locale (index.html ships `lang="en"`), so
 * screen readers pronounce Dutch as Dutch, and hands the shared ui
 * components their translated screen-reader labels.
 */
export function AccessibilityBridge({ children }: Readonly<{ children: ReactNode }>) {
  const { language, t } = useI18n();

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const labels = useMemo<UiLabels>(
    () => ({
      close: t.common.actions.close,
      search: t.common.actions.search,
      send: t.common.a11y.send,
      presence: t.common.a11y.presence,
    }),
    [t],
  );

  return <UiLabelsProvider labels={labels}>{children}</UiLabelsProvider>;
}
