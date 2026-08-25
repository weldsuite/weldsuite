/**
 * Picker for switching the active administration (legal entity).
 *
 * Same role as the platform `EntitySwitcher`: picking a row writes the
 * selection to context, which keeps `X-Accounting-Entity-Id` in sync. Mounted
 * once in the entity gate so Home, More and Settings can all open it.
 */

import React, { useCallback } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Building2, Check } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import { Divider } from '@weldsuite/mobile-ui/components/Divider';

import { useAccountingEntity } from '@/contexts/AccountingEntityContext';
import { IconTile } from '@/components/detail';
import { ACCENTS, BRAND } from '@/lib/brand';
import type { AccountingEntity } from '@/types/accounting';
import { useI18n } from '@/lib/i18n';

function entityMeta(entity: AccountingEntity): string {
  const parts = [entity.jurisdictionCode, entity.baseCurrency];
  if (entity.legalName && entity.legalName !== entity.name) parts.push(entity.legalName);
  return parts.filter(Boolean).join(' · ');
}

export function AdministrationSheet() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const { entities, activeEntity, setActiveEntity, switcherOpen, closeSwitcher } =
    useAccountingEntity();

  const select = useCallback(
    (id: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setActiveEntity(id);
    },
    [setActiveEntity],
  );

  return (
    <Sheet visible={switcherOpen} onClose={closeSwitcher} title={t.administrations.title} heightRatio={0.55}>
      {entities.map((entity, index) => {
        const selected = entity.id === activeEntity?.id;
        return (
          <React.Fragment key={entity.id}>
            {index > 0 ? <Divider /> : null}
            <Pressable
              onPress={() => select(entity.id)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={entity.name}
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}
            >
              <IconTile icon={Building2} color={ACCENTS.settings} />
              <View style={styles.rowText}>
                <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
                  {entity.name}
                </Text>
                <Text style={[styles.rowSubtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
                  {entityMeta(entity)}
                  {entity.isDefault ? ` · ${t.common.default}` : ''}
                </Text>
              </View>
              {selected ? <Check size={18} color={BRAND} /> : <View style={styles.checkSlot} />}
            </Pressable>
          </React.Fragment>
        );
      })}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
    gap: 12,
    borderRadius: 12,
  },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 16, fontWeight: '600' },
  rowSubtitle: { fontSize: 13, marginTop: 2 },
  checkSlot: { width: 18 },
});
