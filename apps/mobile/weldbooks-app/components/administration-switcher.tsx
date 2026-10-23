/**
 * Picker for switching the active administration (legal entity).
 *
 * Same role as the platform `EntitySwitcher`: picking a row writes the
 * selection to context, which keeps `X-Accounting-Entity-Id` in sync, and
 * "Add company" creates another administration and switches to it. Mounted
 * once in the entity gate so Home, More and Settings can all open it.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Building2, Check, Plus } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import { Divider } from '@weldsuite/mobile-ui/components/Divider';

import { useAccountingEntity } from '@/contexts/AccountingEntityContext';
import { CreateEntitySheet } from '@/components/entity-setup';
import { IconTile } from '@/components/detail';
import { ACCENTS, BRAND } from '@/lib/brand';
import type { AccountingEntity } from '@/types/accounting';
import { useI18n } from '@/lib/i18n';

/** The switcher's own close animation; a second modal opened during it can fail to show on iOS. */
const SHEET_HANDOFF_MS = 320;

function entityMeta(entity: AccountingEntity): string {
  const parts = [entity.jurisdictionCode, entity.baseCurrency];
  if (entity.legalName && entity.legalName !== entity.name) parts.push(entity.legalName);
  return parts.filter(Boolean).join(' · ');
}

export function AdministrationSheet() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const { entities, activeEntity, setActiveEntity, adoptEntity, refresh, switcherOpen, closeSwitcher } =
    useAccountingEntity();
  const [adding, setAdding] = useState(false);
  const handoffRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (handoffRef.current) clearTimeout(handoffRef.current);
  }, []);

  const select = useCallback(
    (id: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setActiveEntity(id);
    },
    [setActiveEntity],
  );

  const startAdding = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    closeSwitcher();
    handoffRef.current = setTimeout(() => setAdding(true), SHEET_HANDOFF_MS);
  }, [closeSwitcher]);

  const handleCreated = useCallback(
    (entity: AccountingEntity) => {
      adoptEntity(entity);
      // The created row is enough to switch; the refresh fills in what the list endpoint adds.
      void refresh();
    },
    [adoptEntity, refresh],
  );

  return (
    <>
      <Sheet visible={switcherOpen} onClose={closeSwitcher} title={t.administrations.title} heightRatio={0.6}>
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
        <Divider />
        <Pressable
          onPress={startAdding}
          accessibilityRole="button"
          accessibilityLabel={t.administrations.add}
          testID="administration-add"
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressed }]}
        >
          <View style={[styles.addTile, { borderColor: colors.border }]}>
            <Plus size={18} color={BRAND} />
          </View>
          <View style={styles.rowText}>
            <Text style={[styles.rowTitle, { color: BRAND }]}>{t.administrations.add}</Text>
            <Text style={[styles.rowSubtitle, { color: colors.mutedForeground }]} numberOfLines={2}>
              {t.administrations.addHint}
            </Text>
          </View>
        </Pressable>
      </Sheet>

      {/* Mounted per opening, so the form starts empty and on the current company's country. */}
      {adding ? (
        <CreateEntitySheet
          visible
          onClose={() => setAdding(false)}
          onCreated={handleCreated}
          additional
          // A second company is usually registered where the first one is.
          initialJurisdiction={activeEntity?.jurisdictionCode}
        />
      ) : null}
    </>
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
  addTile: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
