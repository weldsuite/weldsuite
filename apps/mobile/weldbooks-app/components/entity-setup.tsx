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
 *
 * A US company also says how it is organised (LLC, S corporation, ...) and how
 * the IRS taxes it, gives its EIN and its address (the origin of its sales
 * tax), and starts in USD.
 */

import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Select } from '@weldsuite/mobile-ui/components/Select';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import { Screen } from './screen';
import { AddressFields } from './address-fields';
import api from '@/services/api';
import { useJurisdictions } from '@/hooks/useJurisdiction';
import { useI18n } from '@/lib/i18n';
import {
  BUILT_IN_JURISDICTIONS,
  DEFAULT_TERMINOLOGY,
  defaultJurisdictionCode,
  findJurisdiction,
  isUsJurisdiction,
  terminologyLabels,
} from '@/lib/jurisdiction';
import { describeApiError } from '@/lib/sales-tax';
import {
  EMPTY_ADDRESS,
  einProblem,
  formatEinInput,
  normalizeEin,
  toApiAddress,
  usAddressProblems,
  usEntityTypes,
  validClassification,
  type AddressDraft,
} from '@/lib/us';

/** Building with a door — the same motif as the platform's empty-state illustration. */
function EntityIllustration({ stroke, fill, accent }: Readonly<{ stroke: string; fill: string; accent: string }>) {
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

export function CreateEntitySheet({
  visible,
  onClose,
  onCreated,
}: Readonly<{
  visible: boolean;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}>) {
  const { colors } = useTheme();
  const toast = useToast();
  const { t, format } = useI18n();
  // The API's list once it has loaded; the built-in table (same jurisdictions) until then.
  const { data: loaded } = useJurisdictions();
  const jurisdictions = loaded && loaded.length > 0 ? loaded : BUILT_IN_JURISDICTIONS;

  const initialCode = defaultJurisdictionCode();
  const initial = findJurisdiction(initialCode, loaded);

  const [name, setName] = useState('');
  const [jurisdictionCode, setJurisdictionCode] = useState(initialCode);
  const [baseCurrency, setBaseCurrency] = useState(initial?.defaultCurrency ?? 'EUR');
  const [taxId, setTaxId] = useState('');
  const [entityType, setEntityType] = useState('single_member_llc');
  const [taxClassification, setTaxClassification] = useState('disregarded');
  const [dba, setDba] = useState('');
  const [address, setAddress] = useState<AddressDraft>({ ...EMPTY_ADDRESS });
  const [submitting, setSubmitting] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>();
  const [einError, setEinError] = useState<string | undefined>();
  const [addressErrors, setAddressErrors] = useState<ReturnType<typeof usAddressProblems>>({});

  const jurisdiction = findJurisdiction(jurisdictionCode, loaded);
  const isUs = isUsJurisdiction(jurisdictionCode);
  const labels = terminologyLabels(t.terminology, jurisdiction?.terminology ?? DEFAULT_TERMINOLOGY);
  const types = usEntityTypes(jurisdiction?.entityTypes);
  const classificationOptions = types.find((type) => type.type === entityType)?.classifications ?? [];

  const currencies = [
    { label: t.entitySetup.currencyEur, value: 'EUR' },
    { label: t.entitySetup.currencyGbp, value: 'GBP' },
    { label: t.entitySetup.currencyUsd, value: 'USD' },
    { label: t.entitySetup.currencyInr, value: 'INR' },
  ];

  const changeJurisdiction = (code: string) => {
    setJurisdictionCode(code);
    // Start each country on its own currency; the picker below can still change it.
    setBaseCurrency(findJurisdiction(code, loaded)?.defaultCurrency ?? baseCurrency);
    setTaxId('');
    setEinError(undefined);
    setAddressErrors({});
  };

  const changeEntityType = (type: string) => {
    setEntityType(type);
    setTaxClassification(validClassification(types, type, taxClassification));
  };

  const handleCreate = useCallback(async () => {
    const trimmed = name.trim();
    let valid = true;

    if (!trimmed) {
      setNameError(t.entitySetup.companyNameError);
      valid = false;
    }

    if (isUs) {
      const problem = einProblem(taxId);
      if (problem) {
        setEinError(problem === 'format' ? t.entitySetup.einFormat : t.entitySetup.einPrefix);
        valid = false;
      }
      // The address is the origin of the company's sales tax, so a state and ZIP are required.
      const problems = usAddressProblems(address, { requireStateAndZip: true });
      setAddressErrors(problems);
      if (Object.keys(problems).length > 0) valid = false;
    }
    if (!valid) return;

    setSubmitting(true);
    setNameError(undefined);
    setEinError(undefined);
    try {
      await api.createEntity({
        name: trimmed,
        jurisdictionCode,
        baseCurrency,
        isDefault: true,
        ...(isUs
          ? {
              entityType,
              taxClassification: validClassification(types, entityType, taxClassification),
              dba: dba.trim() || undefined,
              ein: taxId.trim() ? normalizeEin(taxId) : undefined,
              address: toApiAddress(address),
            }
          : { vatNumber: taxId.trim() || undefined }),
      });
      toast.success(t.entitySetup.created);
      await onCreated();
      onClose();
    } catch (err) {
      toast.error(describeApiError(err, t, t.entitySetup.createFailed));
    } finally {
      setSubmitting(false);
    }
  }, [
    name,
    isUs,
    taxId,
    address,
    jurisdictionCode,
    baseCurrency,
    entityType,
    taxClassification,
    dba,
    types,
    toast,
    onCreated,
    onClose,
    t,
  ]);

  return (
    <Sheet visible={visible} onClose={onClose} title={t.entitySetup.sheetTitle} heightRatio={isUs ? 0.94 : 0.82}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.sheetBody}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetContent}>
          <Text style={[styles.sheetHint, { color: colors.mutedForeground }]}>
            {t.entitySetup.hint}
          </Text>

          <Select
            label={t.entitySetup.jurisdiction}
            value={jurisdictionCode}
            onValueChange={changeJurisdiction}
            options={jurisdictions.map((j) => ({ label: `${j.name} (${j.code})`, value: j.code }))}
          />

          <Input
            label={t.entitySetup.companyName}
            value={name}
            onChangeText={(text) => {
              setName(text);
              if (nameError) setNameError(undefined);
            }}
            placeholder={isUs ? t.examples.companyUs : t.entitySetup.companyNamePlaceholder}
            error={nameError}
            autoCapitalize="words"
            returnKeyType="next"
          />

          {isUs ? (
            <>
              <Select
                label={t.entitySetup.entityType}
                value={entityType}
                onValueChange={changeEntityType}
                options={types.map((type) => ({
                  label: (t.entitySetup.entityTypes as Record<string, string>)[type.type] ?? type.label,
                  value: type.type,
                }))}
              />
              <View style={styles.group}>
                <Select
                  label={t.entitySetup.taxClassification}
                  value={validClassification(types, entityType, taxClassification)}
                  onValueChange={setTaxClassification}
                  options={classificationOptions.map((option) => {
                    const label =
                      (t.entitySetup.taxClassifications as Record<string, string>)[option.value] ?? option.value;
                    return {
                      label: option.formLabel ? format(t.entitySetup.classificationOption, { label, form: option.formLabel }) : label,
                      value: option.value,
                    };
                  })}
                  disabled={classificationOptions.length <= 1}
                />
                <Text style={[styles.fieldHint, { color: colors.mutedForeground }]}>
                  {t.entitySetup.classificationHint}
                </Text>
              </View>
              <Input
                label={t.entitySetup.dba}
                value={dba}
                onChangeText={setDba}
                placeholder={t.entitySetup.dbaPlaceholder}
                autoCapitalize="words"
              />
            </>
          ) : null}

          <Select
            label={t.entitySetup.baseCurrency}
            value={baseCurrency}
            onValueChange={setBaseCurrency}
            options={currencies}
          />

          <Input
            label={format(t.entitySetup.taxIdOptional, { taxId: labels.taxId })}
            value={taxId}
            onChangeText={(text) => {
              setTaxId(isUs ? formatEinInput(text) : text);
              if (einError) setEinError(undefined);
            }}
            placeholder={labels.taxIdPlaceholder}
            helperText={isUs && !einError ? t.entitySetup.einHint : undefined}
            error={einError}
            keyboardType={isUs ? 'number-pad' : 'default'}
            autoCapitalize="characters"
            autoCorrect={false}
          />

          {isUs ? (
            <View style={styles.group}>
              <Text style={[styles.groupTitle, { color: colors.text }]}>{t.entitySetup.businessAddress}</Text>
              <Text style={[styles.fieldHint, { color: colors.mutedForeground }]}>
                {t.entitySetup.addressHint}
              </Text>
              <AddressFields
                value={address}
                onChange={(next) => {
                  setAddress(next);
                  if (Object.keys(addressErrors).length > 0) setAddressErrors({});
                }}
                errors={addressErrors}
              />
            </View>
          ) : null}

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

export function EntityEmptyState({ onCreated }: Readonly<{ onCreated: () => void | Promise<void> }>) {
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
  group: { gap: 8 },
  groupTitle: { fontSize: 15, fontWeight: '600' },
  fieldHint: { fontSize: 12, lineHeight: 17 },
});
