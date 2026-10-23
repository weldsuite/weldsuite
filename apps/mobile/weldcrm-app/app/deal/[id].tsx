import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { MoreHorizontal } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { PersonPicker } from '@/components/company-picker';
import { parseCustomDrafts } from '@/components/custom-fields';
import {
  DealActivityList,
  DealDetailsView,
  DealEditForm,
  DealSummary,
  dealStatusColor,
  dealFormUpdate,
  formFromDeal,
  useDealData,
  validateDealForm,
  type DealErrors,
  type DealForm,
  type DealPicker,
} from '@/components/deal-parts';
import { StackHeader } from '@/components/headers';
import { MemberPicker, useMembers } from '@/components/member-picker';
import { OptionSheet, ScrollTabs } from '@/components/option-sheet';
import { RecordHeaderActions } from '@/components/record';
import { api, type DealStatus, type DealUpdate } from '@/services/api';
import { interpolate, useI18n } from '@/lib/i18n';
import { DEAL_CURRENCIES } from '@/lib/money';

const CHANCE_OPTIONS = [0, 10, 25, 50, 75, 90, 100];

type Tab = 'details' | 'activity';
type Picker = DealPicker | 'actions' | null;
type DealAction = 'edit' | 'won' | 'lost' | 'open' | 'delete';

export default function DealScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const { members, byId } = useMembers();
  const memberName = (userId: string) => byId.get(userId)?.name;

  const data = useDealData(id, () => toast.error(t.deals.loadDealFailed));
  const { deal, setDeal, pipeline, contactName, defs } = data;

  const [busy, setBusy] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState<DealForm | null>(null);
  const [errors, setErrors] = useState<DealErrors>({});
  const [customErrors, setCustomErrors] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<Tab>('details');
  const [picker, setPicker] = useState<Picker>(null);

  // A fresh form whenever the deal (re)loads, unless a half-filled one is open.
  useEffect(() => {
    if (deal && !isEditing) setForm(formFromDeal(deal, contactName, defs ?? []));
  }, [deal, contactName, defs, isEditing]);

  const save = async (update: DealUpdate, toastText: string) => {
    if (!deal) return false;
    setBusy(true);
    const res = await api.updateDeal(deal.id, update);
    setBusy(false);
    if (res.success && res.data) {
      setDeal(res.data);
      toast.success(toastText);
      return true;
    }
    toast.error(typeof res.error === 'string' ? res.error : t.deals.saveFailed);
    return false;
  };

  const setStatus = (status: DealStatus) => {
    if (status === 'open') {
      void save({ status }, t.deals.reopenedToast);
      return;
    }
    const won = status === 'won';
    Alert.alert(won ? t.deals.confirmWon : t.deals.confirmLost, undefined, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: won ? t.deals.markWon : t.deals.markLost,
        onPress: () => void save({ status }, won ? t.deals.wonToast : t.deals.lostToast),
      },
    ]);
  };

  const remove = async () => {
    if (!deal) return;
    const res = await api.deleteDeal(deal.id);
    if (res.success) {
      toast.success(t.deals.deletedToast);
      router.back();
    } else {
      toast.error(t.deals.deleteFailed);
    }
  };

  const handleDelete = () => {
    if (!deal) return;
    Alert.alert(t.deals.deleteTitle, interpolate(t.deals.deleteMessage, { name: deal.name }), [
      { text: t.common.cancel, style: 'cancel' },
      { text: t.common.delete, style: 'destructive', onPress: () => void remove() },
    ]);
  };

  const startEdit = () => {
    if (!deal) return;
    setForm(formFromDeal(deal, contactName, defs ?? []));
    setErrors({});
    setCustomErrors({});
    setTab('details');
    setIsEditing(true);
  };

  const handleSave = async () => {
    if (!form || !deal) return;
    const found = validateDealForm(form);
    const parsedCustom = defs ? parseCustomDrafts(defs, form.customDrafts) : { values: {}, errors: {} };
    setErrors(found);
    setCustomErrors(parsedCustom.errors);
    if (Object.keys(found).length > 0 || Object.keys(parsedCustom.errors).length > 0) return;
    if (await save(dealFormUpdate(form, deal, defs, parsedCustom.values), t.deals.savedToast)) {
      data.setContactName(form.contact?.name);
      setIsEditing(false);
    }
  };

  const runAction = (action: DealAction | null) => {
    setPicker(null);
    if (action === 'edit') startEdit();
    if (action === 'won' || action === 'lost' || action === 'open') setStatus(action);
    if (action === 'delete') handleDelete();
  };

  const moveStage = (stageId: string | null) => {
    setPicker(null);
    if (!stageId || !deal) return;
    if (isEditing) {
      setForm((prev) => (prev ? { ...prev, stageId } : prev));
      return;
    }
    if (stageId === deal.stageId) return;
    const stageName = pipeline?.stages.find((s) => s.id === stageId)?.name ?? '';
    void save({ stageId }, interpolate(t.deals.movedToast, { stage: stageName }));
  };

  if (data.loading || !deal || !form) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <StackHeader title={name || t.deals.deal} onBack={() => router.back()} />
        <View style={styles.center}>
          {data.loading ? (
            <ActivityIndicator size="large" color={colors.text} />
          ) : (
            <Text style={{ color: colors.muted }}>{t.deals.loadDealFailed}</Text>
          )}
        </View>
      </View>
    );
  }

  const stage = pipeline?.stages.find((s) => s.id === (isEditing ? form.stageId : deal.stageId));
  const closeActions: { value: DealAction; label: string; color?: string }[] =
    deal.status === 'open'
      ? [
          { value: 'won', label: t.deals.markWon, color: dealStatusColor('won') },
          { value: 'lost', label: t.deals.markLost, color: dealStatusColor('lost') },
        ]
      : [{ value: 'open', label: t.deals.reopen }];

  let body: React.ReactNode;
  if (isEditing) {
    body = (
      <DealEditForm
        form={form}
        errors={errors}
        customErrors={customErrors}
        stage={stage}
        defs={defs}
        members={members}
        memberName={memberName}
        onChange={setForm}
        onOpenPicker={setPicker}
      />
    );
  } else if (tab === 'details') {
    body = <DealDetailsView deal={deal} pipeline={pipeline} contactName={contactName} defs={defs} memberName={memberName} />;
  } else {
    body = <DealActivityList deal={deal} activities={data.activities} />;
  }

  const headerRight = isEditing ? (
    <RecordHeaderActions
      isEditing
      saving={busy}
      onCancel={() => setIsEditing(false)}
      onSave={() => void handleSave()}
      onEdit={startEdit}
      onDelete={handleDelete}
    />
  ) : (
    <TouchableOpacity onPress={() => setPicker('actions')} style={styles.headerButton} accessibilityRole="button" accessibilityLabel={t.records.actions}>
      <MoreHorizontal size={22} color={colors.text} />
    </TouchableOpacity>
  );

  return (
    <KeyboardAvoidingView style={[styles.container, { backgroundColor: colors.background }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ headerShown: false }} />
      <StackHeader
        title={isEditing ? t.deals.editTitle : deal.name}
        onBack={() => (isEditing ? setIsEditing(false) : router.back())}
        right={headerRight}
      />
      <ScrollView style={styles.content} keyboardShouldPersistTaps="handled" stickyHeaderIndices={isEditing ? undefined : [1]}>
        <DealSummary
          deal={deal}
          stage={stage}
          busy={busy}
          stageLocked={isEditing}
          onStagePress={() => setPicker('stage')}
        />
        {isEditing ? (
          <View />
        ) : (
          <ScrollTabs<Tab>
            tabs={[
              { key: 'details', label: t.records.tabs.details },
              { key: 'activity', label: t.records.tabs.activity, count: data.activities.length || undefined },
            ]}
            active={tab}
            onChange={setTab}
          />
        )}
        <View style={styles.panel}>{body}</View>
        <View style={styles.bottomSpace} />
      </ScrollView>

      <OptionSheet<DealAction>
        visible={picker === 'actions'}
        title={deal.name}
        options={[
          { value: 'edit', label: t.common.edit },
          ...closeActions,
          { value: 'delete', label: t.common.delete, color: colors.destructive },
        ]}
        onSelect={runAction}
        onClose={() => setPicker(null)}
      />
      <OptionSheet<string>
        visible={picker === 'stage'}
        title={t.deals.stage}
        options={(pipeline?.stages ?? []).map((s) => ({ value: s.id, label: s.name, color: s.color }))}
        selected={isEditing ? form.stageId : deal.stageId}
        onSelect={moveStage}
        onClose={() => setPicker(null)}
      />
      <OptionSheet<string>
        visible={picker === 'currency'}
        title={t.deals.currency}
        options={[...new Set([form.currency, ...DEAL_CURRENCIES])].map((code) => ({ value: code, label: code }))}
        selected={form.currency}
        onSelect={(code) => {
          setPicker(null);
          if (code) setForm({ ...form, currency: code });
        }}
        onClose={() => setPicker(null)}
      />
      <OptionSheet<string>
        visible={picker === 'chance'}
        title={t.deals.chance}
        options={CHANCE_OPTIONS.map((n) => ({ value: String(n), label: `${n}%` }))}
        selected={form.probability === undefined ? null : String(form.probability)}
        onSelect={(v) => {
          setPicker(null);
          setForm({ ...form, probability: v === null ? undefined : Number(v) });
        }}
        onClose={() => setPicker(null)}
      />
      <MemberPicker
        visible={picker === 'owner'}
        title={t.records.owner}
        members={members}
        selected={form.ownerId ? [form.ownerId] : []}
        onChange={(ids) => setForm({ ...form, ownerId: ids[0] })}
        onClose={() => setPicker(null)}
      />
      <PersonPicker
        visible={picker === 'contact'}
        onClose={() => setPicker(null)}
        onSelect={(person) => {
          setForm({ ...form, contact: { id: person.id, name: person.name } });
          setPicker(null);
        }}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { flex: 1 },
  headerButton: { padding: 8 },
  panel: { paddingHorizontal: 16, paddingTop: 12 },
  bottomSpace: { height: 40 },
});
