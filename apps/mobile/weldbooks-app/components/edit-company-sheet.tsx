/**
 * Edit company: the name, tax IDs, bank details and address of the active
 * company, through the entity update endpoint (`PATCH /accounting-entities/:id`).
 *
 * Opened from Settings › Company and from an invoice that can't be finalised
 * because the company lacks a field the jurisdiction makes mandatory (BTW
 * number, KvK, IBAN, address, ...). The jurisdiction and the base currency are
 * fixed once the books exist, so they are not editable here.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text, StyleSheet } from 'react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';

import api from '@/services/api';
import { CompanyFields } from '@/components/company-form';
import { SheetForm } from '@/components/sheet-form';
import { useAccountingEntity } from '@/contexts/AccountingEntityContext';
import { useJurisdiction, useJurisdictions } from '@/hooks/useJurisdiction';
import { requiredInvoiceFields } from '@/lib/company';
import {
  buildEntityUpdate,
  companyProblems,
  isEmptyUpdate,
  toCompanyDraft,
  type CompanyDraft,
  type CompanyProblems,
} from '@/lib/company-form';
import { useI18n } from '@/lib/i18n';
import { describeApiError } from '@/lib/sales-tax';
import { usAddressProblems } from '@/lib/us';

export function EditCompanySheet({
  visible,
  onClose,
  onSaved,
}: Readonly<{
  visible: boolean;
  onClose: () => void;
  /** Called after the changes are saved and the company reloaded. */
  onSaved?: () => void;
}>) {
  const { colors } = useTheme();
  const toast = useToast();
  const { t } = useI18n();
  const { activeEntity, refresh } = useAccountingEntity();
  const { code, isUs, labels, terminology } = useJurisdiction();
  const { data: loaded } = useJurisdictions();

  const [draft, setDraft] = useState<CompanyDraft>(() => toCompanyDraft(activeEntity));
  const [problems, setProblems] = useState<CompanyProblems>({});
  const [usAddressErrors, setUsAddressErrors] = useState<ReturnType<typeof usAddressProblems>>({});
  const [saving, setSaving] = useState(false);

  // Start from what is stored each time the sheet opens (not again when the entity refreshes under the user's typing).
  const entityRef = useRef(activeEntity);
  entityRef.current = activeEntity;
  useEffect(() => {
    if (visible) {
      setDraft(toCompanyDraft(entityRef.current));
      setProblems({});
      setUsAddressErrors({});
    }
  }, [visible]);

  const handleChange = useCallback((next: CompanyDraft) => {
    setDraft(next);
    setProblems({});
    setUsAddressErrors({});
  }, []);

  const handleSave = useCallback(async () => {
    if (!activeEntity) return;
    const found = companyProblems(draft, { code: activeEntity.jurisdictionCode, requireName: true });
    // A US address that is started needs its state and ZIP: they decide the sales tax.
    const usErrors = isUs ? usAddressProblems(draft.address) : {};
    setProblems(found);
    setUsAddressErrors(usErrors);
    if (Object.keys(found).length > 0 || Object.keys(usErrors).length > 0) return;

    const update = buildEntityUpdate(activeEntity, draft);
    if (isEmptyUpdate(update)) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      await api.updateEntity(activeEntity.id, update);
      toast.success(t.company.saved);
      await refresh();
      onSaved?.();
      onClose();
    } catch (err) {
      toast.error(describeApiError(err, t, t.company.saveFailed));
    } finally {
      setSaving(false);
    }
  }, [activeEntity, draft, isUs, onClose, onSaved, refresh, toast, t]);

  return (
    <Sheet visible={visible} onClose={onClose} title={t.company.editTitle} heightRatio={0.92}>
      <SheetForm>
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>{t.company.editHint}</Text>

        <Input
          label={t.company.name}
          value={draft.name}
          onChangeText={(name) => handleChange({ ...draft, name })}
          error={problems.name ? t.entitySetup.companyNameError : undefined}
          autoCapitalize="words"
        />

        <CompanyFields
          code={code ?? ''}
          draft={draft}
          onChange={handleChange}
          problems={problems}
          usAddressErrors={usAddressErrors}
          requiredFields={requiredInvoiceFields(code, loaded)}
          labels={labels}
          terminology={terminology}
          taxIdLabel={labels.taxId}
        />

        <Button title={t.company.save} onPress={handleSave} loading={saving} fullWidth style={styles.submit} />
      </SheetForm>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 13, lineHeight: 19 },
  submit: { marginTop: 8 },
});
