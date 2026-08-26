/**
 * First-entity setup door.
 *
 * The mobile twin of the platform's `EntityEmptyState` + `CreateEntityDialog`
 * (PR #93). Shown instead of the tab bar when the workspace has no legal entity,
 * so the user creates one before hitting entity-scoped screens that would
 * otherwise 400.
 *
 * Creating with `seedDefaults` installs the jurisdiction's chart of accounts,
 * tax rates and number sequences — an entity without them can't issue anything,
 * so this flow never offers to skip it.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Select } from '@weldsuite/mobile-ui/components/Select';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import { Screen } from './screen';
import api from '@/services/api';
import type { Jurisdiction } from '@/types/accounting';
import { useI18n } from '@/lib/i18n';

/** Building with a door — the same motif as the platform's empty-state illustration. */
function EntityIllustration({ stroke, fill, accent }: { stroke: string; fill: string; accent: string }) {
  return (
    <Svg width={120} height={120} viewBox="0 0 120 120">
      <Rect x={28} y={34} width={64} height={58} rx={4} fill={fill} stroke={stroke} strokeWidth={1} />
      <Rect x={28} y={34} width={64} height={8} rx={2} fill={accent} />
      <Rect x={40} y={50} width={12} height={10} rx={1.5} fill={accent} />
      <Rect x={58} y={50} width={12} height={10} rx={1.5} fill={accent} />
      <Rect x={76} y={50} width={8} height={10} rx={1.5} fill={accent} />
      <Rect x={40} y={66} width={12} height={10} rx={1.5} fill={accent} />
      <Rect x={58} y={66} width={12} height={10} rx={1.5} fill={accent} />
      {/* The literal entry to first-entity setup. */}
      <Rect x={74} y={66} width={10} height={26} rx={1.5} fill={stroke} />
    </Svg>
  );
}

const FALLBACK_JURISDICTIONS: Jurisdiction[] = [
  { code: 'NL', name: 'Netherlands' },
  { code: 'BE', name: 'Belgium' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'UK', name: 'United Kingdom' },
  { code: 'US', name: 'United States' },
];

export function CreateEntitySheet({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const { colors } = useTheme();
  const toast = useToast();
  const { t } = useI18n();

  const currencies = [
    { label: t.entitySetup.currencyEur, value: 'EUR' },
    { label: t.entitySetup.currencyGbp, value: 'GBP' },
    { label: t.entitySetup.currencyUsd, value: 'USD' },
  ];

  const [jurisdictions, setJurisdictions] = useState<Jurisdiction[]>(FALLBACK_JURISDICTIONS);
  const [name, setName] = useState('');
  const [jurisdictionCode, setJurisdictionCode] = useState('NL');
  const [baseCurrency, setBaseCurrency] = useState('EUR');
  const [vatNumber, setVatNumber] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>();

  useEffect(() => {
    if (!visible) return;
    api
      .getJurisdictions()
      .then((rows) => {
        if (rows.length) setJurisdictions(rows);
      })
      // The fallback list covers every jurisdiction with an adapter today.
      .catch(() => undefined);
  }, [visible]);

  const handleCreate = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(t.entitySetup.companyNameError);
      return;
    }

    setSubmitting(true);
    setNameError(undefined);
    try {
      await api.createEntity({
        name: trimmed,
        jurisdictionCode,
        baseCurrency,
        vatNumber: vatNumber.trim() || undefined,
        isDefault: true,
      });
      toast.success(t.entitySetup.created);
      await onCreated();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.entitySetup.createFailed);
    } finally {
      setSubmitting(false);
    }
  }, [name, jurisdictionCode, baseCurrency, vatNumber, toast, onCreated, onClose, t]);

  return (
    <Sheet visible={visible} onClose={onClose} title={t.entitySetup.sheetTitle} heightRatio={0.82}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.sheetBody}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetContent}>
          <Text style={[styles.sheetHint, { color: colors.mutedForeground }]}>
            {t.entitySetup.hint}
          </Text>

          <Input
            label={t.entitySetup.companyName}
            value={name}
            onChangeText={(text) => {
              setName(text);
              if (nameError) setNameError(undefined);
            }}
            placeholder={t.entitySetup.companyNamePlaceholder}
            error={nameError}
            autoCapitalize="words"
            returnKeyType="next"
          />

          <Select
            label={t.entitySetup.jurisdiction}
            value={jurisdictionCode}
            onValueChange={setJurisdictionCode}
            options={jurisdictions.map((j) => ({ label: `${j.name} (${j.code})`, value: j.code }))}
          />

          <Select
            label={t.entitySetup.baseCurrency}
            value={baseCurrency}
            onValueChange={setBaseCurrency}
            options={currencies}
          />

          <Input
            label={t.entitySetup.vatNumberOptional}
            value={vatNumber}
            onChangeText={setVatNumber}
            placeholder={t.entitySetup.vatNumberPlaceholder}
            autoCapitalize="characters"
            autoCorrect={false}
          />

          <Button
            title={t.entitySetup.createCompany}
            onPress={handleCreate}
            loading={submitting}
            fullWidth
            style={styles.sheetSubmit}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Sheet>
  );
}

export function EntityEmptyState({ onCreated }: { onCreated: () => void | Promise<void> }) {
  const { colors, theme } = useTheme();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <Screen>
      <View style={styles.container}>
        <EntityIllustration
          stroke={colors.border}
          fill={theme === 'dark' ? 'rgba(255,255,255,0.03)' : '#FFFFFF'}
          accent={theme === 'dark' ? 'rgba(255,255,255,0.15)' : '#F1F5F9'}
        />
        <Text style={[styles.title, { color: colors.text }]}>{t.entitySetup.emptyTitle}</Text>
        <Text style={[styles.description, { color: colors.mutedForeground }]}>
          {t.entitySetup.emptyDescription}
        </Text>
        <Button title={t.entitySetup.createCompany} onPress={() => setOpen(true)} style={styles.cta} />
      </View>

      <CreateEntitySheet visible={open} onClose={() => setOpen(false)} onCreated={onCreated} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  title: { fontSize: 17, fontWeight: '600', marginTop: 20, marginBottom: 8 },
  description: { fontSize: 14, lineHeight: 21, textAlign: 'center', maxWidth: 320 },
  cta: { marginTop: 24, minWidth: 200 },
  sheetBody: { flex: 1 },
  sheetContent: { padding: 16, gap: 16, paddingBottom: 40 },
  sheetHint: { fontSize: 13, lineHeight: 19 },
  sheetSubmit: { marginTop: 8 },
});
