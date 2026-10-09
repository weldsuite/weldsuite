/**
 * Shown instead of a screen whose feature the active entity's jurisdiction
 * doesn't have (the Dutch VAT return on a US company). The More menu already
 * hides the entry; this covers a deep link or a stale navigation stack.
 */

import React from 'react';
import { Ban } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';

import { Screen, ScreenHeader } from '@/components/screen';
import { useI18n } from '@/lib/i18n';

export function FeatureUnavailable({ title }: Readonly<{ title?: string }>) {
  const { colors } = useTheme();
  const { t } = useI18n();

  return (
    <Screen header={<ScreenHeader title={title ?? t.common.notAvailableTitle} showBack />}>
      <EmptyState
        icon={<Ban size={32} color={colors.mutedForeground} />}
        title={t.common.notAvailableTitle}
        description={t.common.notAvailableDescription}
      />
    </Screen>
  );
}
