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
 * tax), and starts in USD. A Brazilian company gives its legal form and tax
 * regime (they decide which taxes its invoices carry and are seeded at
 * creation) and its CNPJ, and starts in BRL. A Dutch company can give its BTW
 * number, KvK number, IBAN and address right away: books-api won't finalise an
 * invoice without them.
 *
 * The door is also the dead end of a workspace that has no company, so it offers
 * the way out: set the company up on the web, switch workspace, or sign out.
 */

import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { Check } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';
import { Divider } from '@weldsuite/mobile-ui/components/Divider';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Select } from '@weldsuite/mobile-ui/components/Select';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import { Screen } from './screen';
import { CompanyFields } from './company-form';
import { SheetForm } from './sheet-form';
import api from '@/services/api';
import { useJurisdictions } from '@/hooks/useJurisdiction';
import { useI18n } from '@/lib/i18n';
import { BRAND } from '@/lib/brand';
import { requiredInvoiceFields } from '@/lib/company';
import {
  companyProblems,
  emptyCompanyDraft,
  normalizeTaxId,
  toGenericAddress,
  type CompanyDraft,
} from '@/lib/company-form';
import {
  BUILT_IN_JURISDICTIONS,
  DEFAULT_TERMINOLOGY,
  defaultJurisdictionCode,
  findJurisdiction,
  isBrJurisdiction,
  isUsJurisdiction,
  terminologyLabels,
} from '@/lib/jurisdiction';
import { BR_ENTITY_TYPES, allowedBrRegimes, validBrRegime } from '@/lib/br';
import { describeApiError } from '@/lib/sales-tax';
import {
  toApiAddress,
  usAddressProblems,
  usEntityTypes,
  validClassification,
} from '@/lib/us';
import type { AccountingEntity, PostalAddress } from '@/types/accounting';

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

/** The jurisdiction-specific part of the create body: US organisation and address, Brazilian legal form and regime, else tax IDs and bank details. */
function jurisdictionPayload(draft: {
  code: string;
  isUs: boolean;
  isBr: boolean;
  company: CompanyDraft;
  entityType: string;
  taxClassification: string;
  types: ReturnType<typeof usEntityTypes>;
  dba: string;
  brEntityType: string;
  brRegime: string;
}): {
  entityType?: string;
  taxClassification?: string;
  dba?: string;
  ein?: string;
  vatNumber?: string;
  registrationNumber?: string;
  iban?: string;
  bic?: string;
  address?: PostalAddress | null;
} {
  const { company } = draft;
  const taxId = normalizeTaxId(company.taxId, draft.code);
  if (draft.isUs) {
    return {
      entityType: draft.entityType,
      taxClassification: validClassification(draft.types, draft.entityType, draft.taxClassification),
      dba: draft.dba.trim() || undefined,
      ein: taxId || undefined,
      address: toApiAddress(company.address),
    };
  }
  const address = toGenericAddress(company.address, draft.code);
  if (draft.isBr) {
    return {
      entityType: draft.brEntityType,
      taxClassification: validBrRegime(draft.brEntityType, draft.brRegime),
      vatNumber: taxId || undefined,
      address,
    };
  }
  return {
    vatNumber: taxId || undefined,
    registrationNumber: company.registrationNumber.trim() || undefined,
    iban: company.iban.trim() ? company.iban.replaceAll(/\s+/g, '').toUpperCase() : undefined,
    bic: company.bic.trim().toUpperCase() || undefined,
    address,
  };
}

export function CreateEntitySheet({
  visible,
  onClose,
  onCreated,
  additional = false,
  initialJurisdiction,
}: Readonly<{
  visible: boolean;
  onClose: () => void;
  onCreated: (entity: AccountingEntity) => void | Promise<void>;
  /** A second (or later) company: it does not take over as the workspace default. */
  additional?: boolean;
  /** The country to start on; the device's region when not given. */
  initialJurisdiction?: string;
}>) {
  const { colors } = useTheme();
  const toast = useToast();
  const { t, format } = useI18n();
  // The API's list once it has loaded; the built-in table (same jurisdictions) until then.
  const { data: loaded } = useJurisdictions();
  const jurisdictions = loaded && loaded.length > 0 ? loaded : BUILT_IN_JURISDICTIONS;

  const initialCode = initialJurisdiction ?? defaultJurisdictionCode();
  const initial = findJurisdiction(initialCode, loaded);

  const [company, setCompany] = useState<CompanyDraft>(() => emptyCompanyDraft());
  const [jurisdictionCode, setJurisdictionCode] = useState(initialCode);
  const [baseCurrency, setBaseCurrency] = useState(initial?.defaultCurrency ?? 'EUR');
  const [entityType, setEntityType] = useState('single_member_llc');
  const [taxClassification, setTaxClassification] = useState('disregarded');
  const [dba, setDba] = useState('');
  const [brEntityType, setBrEntityType] = useState<string>('ltda');
  const [brRegime, setBrRegime] = useState<string>('simples_nacional');
  const [submitting, setSubmitting] = useState(false);
  const [problems, setProblems] = useState<ReturnType<typeof companyProblems>>({});
  const [addressErrors, setAddressErrors] = useState<ReturnType<typeof usAddressProblems>>({});

  const jurisdiction = findJurisdiction(jurisdictionCode, loaded);
  const isUs = isUsJurisdiction(jurisdictionCode);
  const isBr = isBrJurisdiction(jurisdictionCode);
  const terminology = jurisdiction?.terminology ?? DEFAULT_TERMINOLOGY;
  const labels = terminologyLabels(t.terminology, terminology);
  const types = usEntityTypes(jurisdiction?.entityTypes);
  const classificationOptions = types.find((type) => type.type === entityType)?.classifications ?? [];
  const required = requiredInvoiceFields(jurisdictionCode, loaded);

  const currencies = [
    { label: t.entitySetup.currencyEur, value: 'EUR' },
    { label: t.entitySetup.currencyGbp, value: 'GBP' },
    { label: t.entitySetup.currencyUsd, value: 'USD' },
    { label: t.entitySetup.currencyInr, value: 'INR' },
    { label: t.entitySetup.currencyBrl, value: 'BRL' },
  ];

  const changeJurisdiction = (code: string) => {
    setJurisdictionCode(code);
    // Start each country on its own currency; the picker below can still change it.
    setBaseCurrency(findJurisdiction(code, loaded)?.defaultCurrency ?? baseCurrency);
    setCompany((prev) => ({ ...prev, taxId: '', registrationNumber: '', iban: '', bic: '' }));
    setProblems({});
    setAddressErrors({});
  };

  const changeEntityType = (type: string) => {
    setEntityType(type);
    setTaxClassification(validClassification(types, type, taxClassification));
  };

  const changeBrEntityType = (type: string) => {
    setBrEntityType(type);
    setBrRegime(validBrRegime(type, brRegime));
  };

  const changeCompany = (next: CompanyDraft) => {
    setCompany(next);
    setProblems({});
    setAddressErrors({});
  };

  const handleCreate = useCallback(async () => {
    const found = companyProblems(company, { code: jurisdictionCode, requireName: true });
    // The US address is the origin of the company's sales tax, so a state and ZIP are required.
    const usErrors = isUs ? usAddressProblems(company.address, { requireStateAndZip: true }) : {};
    setProblems(found);
    setAddressErrors(usErrors);
    if (Object.keys(found).length > 0 || Object.keys(usErrors).length > 0) return;

    setSubmitting(true);
    try {
      const created = await api.createEntity({
        name: company.name.trim(),
        jurisdictionCode,
        baseCurrency,
        isDefault: !additional,
        ...jurisdictionPayload({
          code: jurisdictionCode.toUpperCase(),
          isUs,
          isBr,
          company,
          entityType,
          taxClassification,
          types,
          dba,
          brEntityType,
          brRegime,
        }),
      });
      toast.success(t.entitySetup.created);
      await onCreated(created);
      onClose();
    } catch (err) {
      toast.error(describeApiError(err, t, t.entitySetup.createFailed));
    } finally {
      setSubmitting(false);
    }
  }, [
    company,
    isUs,
    isBr,
    brEntityType,
    brRegime,
    jurisdictionCode,
    baseCurrency,
    entityType,
    taxClassification,
    dba,
    types,
    toast,
    onCreated,
    onClose,
    additional,
    t,
  ]);

  // The company's own fields (IBAN, KvK, address) only matter for invoices; a sheet that grows
  // with its content never needs a fixed height, only a ceiling.
  return (
    <Sheet visible={visible} onClose={onClose} title={additional ? t.entitySetup.addSheetTitle : t.entitySetup.sheetTitle} heightRatio={0.94}>
      <SheetForm>
        <Text style={[styles.sheetHint, { color: colors.mutedForeground }]}>{t.entitySetup.hint}</Text>

        <Select
          label={t.entitySetup.jurisdiction}
          value={jurisdictionCode}
          onValueChange={changeJurisdiction}
          options={jurisdictions.map((j) => ({ label: `${j.name} (${j.code})`, value: j.code }))}
        />

        <Input
          label={t.entitySetup.companyName}
          value={company.name}
          onChangeText={(name) => changeCompany({ ...company, name })}
          placeholder={isUs ? t.examples.companyUs : t.entitySetup.companyNamePlaceholder}
          error={problems.name ? t.entitySetup.companyNameError : undefined}
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

        {isBr ? (
          <>
            <Select
              label={t.entitySetup.entityType}
              value={brEntityType}
              onValueChange={changeBrEntityType}
              options={BR_ENTITY_TYPES.map((type) => ({
                label: (t.entitySetup.entityTypes as Record<string, string>)[type] ?? type,
                value: type,
              }))}
            />
            <View style={styles.group}>
              <Select
                label={t.entitySetup.taxRegime}
                value={validBrRegime(brEntityType, brRegime)}
                onValueChange={setBrRegime}
                options={allowedBrRegimes(brEntityType).map((regime) => ({
                  label: (t.entitySetup.taxClassifications as Record<string, string>)[regime] ?? regime,
                  value: regime,
                }))}
                disabled={allowedBrRegimes(brEntityType).length <= 1}
              />
              <Text style={[styles.fieldHint, { color: colors.mutedForeground }]}>{t.entitySetup.regimeHint}</Text>
            </View>
          </>
        ) : null}

        <Select
          label={t.entitySetup.baseCurrency}
          value={baseCurrency}
          onValueChange={setBaseCurrency}
          options={currencies}
        />

        {isUs ? null : (
          <Text style={[styles.groupTitle, { color: colors.text }]}>{t.entitySetup.invoiceDetails}</Text>
        )}
        {isUs ? null : (
          <Text style={[styles.fieldHint, { color: colors.mutedForeground }]}>
            {t.entitySetup.invoiceDetailsHint}
          </Text>
        )}

        <CompanyFields
          code={jurisdictionCode.toUpperCase()}
          draft={company}
          onChange={changeCompany}
          problems={problems}
          usAddressErrors={addressErrors}
          requiredFields={required}
          labels={labels}
          terminology={terminology}
          taxIdLabel={format(t.entitySetup.taxIdOptional, { taxId: labels.taxId })}
        />

        <Button
          title={t.entitySetup.createCompany}
          onPress={handleCreate}
          loading={submitting}
          fullWidth
          style={styles.sheetSubmit}
          testID="create-company-submit"
        />
      </SheetForm>
    </Sheet>
  );
}

/** Lists the user's workspaces so one with a company can be picked. */
function WorkspaceSheet({ visible, onClose }: Readonly<{ visible: boolean; onClose: () => void }>) {
  const { colors } = useTheme();
  const toast = useToast();
  const { t } = useI18n();
  const { workspaces, currentWorkspace, switchWorkspace } = useWorkspace();
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  const pick = async (clerkOrgId: string) => {
    if (switchingId || clerkOrgId === currentWorkspace?.clerkOrgId) return;
    setSwitchingId(clerkOrgId);
    try {
      await switchWorkspace(clerkOrgId);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.entitySetup.switchWorkspaceFailed);
    } finally {
      setSwitchingId(null);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={t.entitySetup.switchWorkspaceTitle} heightRatio={0.5}>
      {workspaces.map((workspace, index) => {
        const active = workspace.clerkOrgId === currentWorkspace?.clerkOrgId;
        return (
          <React.Fragment key={workspace.clerkOrgId}>
            {index > 0 ? <Divider /> : null}
            <Pressable
              onPress={() => void pick(workspace.clerkOrgId)}
              disabled={active || switchingId !== null}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={workspace.name}
              style={({ pressed }) => [styles.workspaceRow, pressed && { backgroundColor: colors.pressed }]}
            >
              <Text style={[styles.workspaceName, { color: colors.text }]} numberOfLines={1}>
                {workspace.name}
              </Text>
              {active ? <Check size={18} color={BRAND} /> : null}
            </Pressable>
          </React.Fragment>
        );
      })}
    </Sheet>
  );
}

export function EntityEmptyState({ onCreated }: Readonly<{ onCreated: () => void | Promise<void> }>) {
  const { colors, theme } = useTheme();
  const toast = useToast();
  const { t } = useI18n();
  const { signOut } = useClerkAuth();
  const { hasMultipleWorkspaces } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [checking, setChecking] = useState(false);

  const checkAgain = async () => {
    setChecking(true);
    try {
      await onCreated();
    } finally {
      setChecking(false);
    }
  };

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
        <Button
          title={t.entitySetup.createCompany}
          onPress={() => setOpen(true)}
          style={styles.cta}
          testID="create-company-open"
        />
        <Text style={[styles.webHint, { color: colors.mutedForeground }]}>{t.entitySetup.emptyWebHint}</Text>

        <View style={styles.secondary}>
          <Button
            title={t.entitySetup.emptyRefresh}
            variant="ghost"
            size="sm"
            onPress={() => void checkAgain()}
            loading={checking}
          />
          {hasMultipleWorkspaces ? (
            <Button
              title={t.entitySetup.switchWorkspace}
              variant="ghost"
              size="sm"
              onPress={() => setWorkspacesOpen(true)}
            />
          ) : null}
          <Button
            title={t.settings.signOut}
            variant="ghost"
            size="sm"
            textStyle={{ color: colors.destructive }}
            onPress={() => setConfirmSignOut(true)}
          />
        </View>
      </View>

      <CreateEntitySheet visible={open} onClose={() => setOpen(false)} onCreated={onCreated} />
      <WorkspaceSheet visible={workspacesOpen} onClose={() => setWorkspacesOpen(false)} />

      <ConfirmModal
        visible={confirmSignOut}
        title={t.settings.signOutTitle}
        confirmText={t.settings.signOut}
        cancelText={t.common.cancel}
        variant="destructive"
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={async () => {
          setConfirmSignOut(false);
          try {
            await signOut();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : t.settings.signOutFailed);
          }
        }}
      />
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
  webHint: { fontSize: 13, lineHeight: 19, textAlign: 'center', maxWidth: 320, marginTop: 20 },
  secondary: { marginTop: 12, alignItems: 'center', gap: 2 },
  sheetHint: { fontSize: 13, lineHeight: 19 },
  sheetSubmit: { marginTop: 8 },
  group: { gap: 8 },
  groupTitle: { fontSize: 15, fontWeight: '600' },
  fieldHint: { fontSize: 12, lineHeight: 17 },
  workspaceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderRadius: 12,
  },
  workspaceName: { flex: 1, fontSize: 16, fontWeight: '500' },
});
