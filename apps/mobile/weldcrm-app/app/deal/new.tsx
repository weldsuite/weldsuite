import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { CompanyPicker, PersonPicker } from '@/components/company-picker';
import { DueDateField } from '@/components/due-date-field';
import { FormField, FormScreen } from '@/components/form';
import { OptionSheet, SelectField } from '@/components/option-sheet';
import { api, type PipelineWithStages } from '@/services/api';
import { useI18n } from '@/lib/i18n';
import { parseDateInput } from '@/lib/dates';
import { DEAL_CURRENCIES, currencySymbol, resolveCurrency } from '@/lib/money';
import { describeError, optionalText, parseAmountInput, validateDeal, type FormErrors } from '@/lib/validation';

const CHANCE_OPTIONS = [10, 25, 50, 75, 90, 100];

type Picker = 'company' | 'person' | 'pipeline' | 'stage' | 'currency' | null;

/**
 * New deal. Opened from the board (`pipelineId`, `stageId`), a company
 * (`companyId`, `companyName`) or a person (`personId`, `personName`).
 */
export default function NewDealScreen() {
  const params = useLocalSearchParams<{
    pipelineId?: string;
    stageId?: string;
    companyId?: string;
    companyName?: string;
    personId?: string;
    personName?: string;
  }>();
  const { colors } = useTheme();
  const { t, intlLocale } = useI18n();
  const toast = useToast();

  const [pipelines, setPipelines] = useState<PipelineWithStages[]>([]);
  const [pipelineId, setPipelineId] = useState<string | undefined>(params.pipelineId || undefined);
  const [stageId, setStageId] = useState<string | undefined>(params.stageId || undefined);
  const [company, setCompany] = useState(
    params.companyId ? { id: params.companyId, name: params.companyName ?? '' } : null,
  );
  const [person, setPerson] = useState(params.personId ? { id: params.personId, name: params.personName ?? '' } : null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [chance, setChance] = useState<number | null>(null);
  const [closeDate, setCloseDate] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<FormErrors<'name' | 'value' | 'closeDate' | 'company' | 'stage'>>({});
  const [submitting, setSubmitting] = useState(false);
  const [picker, setPicker] = useState<Picker>(null);

  useEffect(() => {
    void (async () => {
      const [pipelinesRes, workspaceCurrency] = await Promise.all([api.getPipelines(), api.getWorkspaceCurrency()]);
      setCurrency(resolveCurrency(workspaceCurrency));
      if (!pipelinesRes.success || !pipelinesRes.data) {
        toast.error(t.deals.loadFailed);
        return;
      }
      const all = pipelinesRes.data;
      setPipelines(all);
      const current = all.find((p) => p.id === params.pipelineId) ?? all[0];
      if (!current) return;
      setPipelineId(current.id);
      setStageId((prev) => (prev && current.stages.some((s) => s.id === prev) ? prev : current.stages[0]?.id));
    })();
  }, [params.pipelineId, t, toast]);

  const pipeline = pipelines.find((p) => p.id === pipelineId);
  const stage = pipeline?.stages.find((s) => s.id === stageId);
  const openStages = useMemo(() => pipeline?.stages ?? [], [pipeline]);

  const message = (field: keyof typeof errors, label: string) => {
    const error = errors[field];
    return error ? describeError(t, error, label) : null;
  };

  const handleCreate = async () => {
    const found = {
      ...validateDeal({ name, value, closeDate }, parseDateInput),
      ...(company ? {} : { company: 'required' as const }),
      ...(stageId ? {} : { stage: 'required' as const }),
    };
    setErrors(found);
    if (Object.keys(found).length > 0 || !company) return;

    setSubmitting(true);
    const due = parseDateInput(closeDate).date;
    const res = await api.createDeal({
      name,
      companyId: company.id,
      primaryContactId: person?.id,
      amount: parseAmountInput(value),
      currency,
      stageId,
      probability: chance ?? undefined,
      // No date typed means no close date, as on the web.
      closeDate: due ? due.toISOString() : undefined,
      notes: optionalText(notes),
      pipelineId,
    });
    setSubmitting(false);

    if (res.success && res.data) {
      toast.success(t.deals.createdToast);
      router.replace({ pathname: '/deal/[id]', params: { id: res.data.id, name: res.data.name } });
    } else {
      toast.error(typeof res.error === 'string' ? res.error : t.deals.createFailed);
    }
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <FormScreen
        title={t.deals.newDeal}
        onClose={() => router.back()}
        submitLabel={t.deals.createDeal}
        onSubmit={() => void handleCreate()}
        submitting={submitting}
      >
        <FormField
          label={t.deals.dealName}
          required
          value={name}
          onChangeText={setName}
          placeholder={t.deals.dealNamePlaceholder}
          error={message('name', t.deals.dealName)}
        />
        <SelectField
          label={t.deals.company}
          required
          value={company?.name}
          placeholder={t.deals.selectCompany}
          error={message('company', t.deals.company)}
          onPress={() => setPicker('company')}
        />
        <SelectField
          label={t.deals.contact}
          value={person?.name}
          placeholder={t.common.optional}
          onPress={() => setPicker('person')}
          onClear={() => setPerson(null)}
        />
        {pipelines.length > 1 && (
          <SelectField label={t.deals.pipeline} value={pipeline?.name} color={pipeline?.color} onPress={() => setPicker('pipeline')} />
        )}
        <SelectField
          label={t.deals.stage}
          required
          value={stage?.name}
          color={stage?.color}
          error={message('stage', t.deals.stage)}
          onPress={() => setPicker('stage')}
        />
        <View style={styles.row}>
          <View style={styles.amount}>
            <FormField
              label={`${t.deals.value} (${currencySymbol(currency, intlLocale)})`}
              value={value}
              onChangeText={setValue}
              placeholder={t.deals.valuePlaceholder}
              error={message('value', t.deals.value)}
              keyboardType="decimal-pad"
            />
          </View>
          <View style={styles.currency}>
            <SelectField label={t.deals.currency} value={currency} onPress={() => setPicker('currency')} />
          </View>
        </View>

        <Text style={[styles.chipsLabel, { color: colors.muted }]}>{t.deals.chance}</Text>
        <View style={styles.chips}>
          {CHANCE_OPTIONS.map((option) => {
            const active = chance === option;
            return (
              <TouchableOpacity
                key={option}
                style={[
                  styles.chip,
                  {
                    backgroundColor: active ? colors.text : colors.background,
                    borderColor: active ? colors.text : colors.divider,
                  },
                ]}
                onPress={() => setChance(active ? null : option)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.chipText, { color: active ? colors.background : colors.text }]}>{option}%</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <DueDateField
          label={t.deals.closingDate}
          value={closeDate}
          onChange={setCloseDate}
          error={message('closeDate', t.deals.closingDate)}
        />
        <FormField
          label={t.deals.notes}
          value={notes}
          onChangeText={setNotes}
          placeholder={t.deals.notesPlaceholder}
          multiline
          numberOfLines={3}
        />
      </FormScreen>

      <CompanyPicker
        visible={picker === 'company'}
        onClose={() => setPicker(null)}
        onSelect={(selected) => {
          setCompany({ id: selected.id, name: selected.name });
          setPicker(null);
        }}
      />
      <PersonPicker
        visible={picker === 'person'}
        onClose={() => setPicker(null)}
        onSelect={(selected) => {
          setPerson({ id: selected.id, name: selected.name });
          setPicker(null);
        }}
      />
      <OptionSheet<string>
        visible={picker === 'pipeline'}
        title={t.deals.pipeline}
        options={pipelines.map((p) => ({ value: p.id, label: p.name, color: p.color }))}
        selected={pipelineId}
        onSelect={(id) => {
          setPicker(null);
          const next = pipelines.find((p) => p.id === id);
          if (!next) return;
          setPipelineId(next.id);
          setStageId(next.stages[0]?.id);
        }}
        onClose={() => setPicker(null)}
      />
      <OptionSheet<string>
        visible={picker === 'stage'}
        title={t.deals.stage}
        options={openStages.map((s) => ({ value: s.id, label: s.name, color: s.color }))}
        selected={stageId}
        onSelect={(id) => {
          setPicker(null);
          if (id) setStageId(id);
        }}
        onClose={() => setPicker(null)}
      />
      <OptionSheet<string>
        visible={picker === 'currency'}
        title={t.deals.currency}
        options={DEAL_CURRENCIES.map((code) => ({ value: code, label: code }))}
        selected={currency}
        onSelect={(code) => {
          setPicker(null);
          if (code) setCurrency(code);
        }}
        onClose={() => setPicker(null)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12 },
  amount: { flex: 2 },
  currency: { flex: 1 },
  chipsLabel: { fontSize: 13, fontWeight: '500', marginBottom: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  chipText: { fontSize: 13, fontWeight: '500' },
});
