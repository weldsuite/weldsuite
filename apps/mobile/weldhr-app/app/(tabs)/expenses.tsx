import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Paperclip, Plus, Receipt } from 'lucide-react-native';
import type { HrSelfDeclaration } from '@weldsuite/app-api-client/domains/weldhr';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { MyHrGate, useSelfState } from '@/components/MyHrGate';
import { Pill, statusTone } from '@/components/Pill';
import { ErrorNote, HeaderButton, Panel, Screen, Section } from '@/components/Screen';
import { BRAND } from '@/constants/brand';
import { useCancelDeclaration, useDeclarations } from '@/hooks/use-weldhr-queries';
import { formatDate, formatDay, formatMoney } from '@/lib/format';
import { labelFor, useI18n } from '@/lib/i18n';
import { openDocument } from '@/utils/open-document';

export default function ExpensesScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const state = useSelfState();
  const declarations = useDeclarations();
  const canClaim = state.status === 'ready' && state.self.features.declarations;

  return (
    <Screen
      title={t.expenses.title}
      refreshing={declarations.isRefetching}
      onRefresh={() => {
        state.refetch();
        void declarations.refetch();
      }}
      action={
        canClaim ? (
          <HeaderButton
            icon={<Plus size={20} color={BRAND} />}
            label={t.expenses.newExpense}
            onPress={() => router.push('/expense/new')}
          />
        ) : undefined
      }
    >
      <MyHrGate state={state}>
        {state.status === 'ready' && !state.self.features.declarations ? (
          <Banner variant="info">{t.expenses.turnedOff}</Banner>
        ) : null}
        <ExpensesBody canClaim={canClaim} />
      </MyHrGate>
    </Screen>
  );
}

function ExpensesBody({ canClaim }: Readonly<{ canClaim: boolean }>) {
  const { colors } = useTheme();
  const { t, intlLocale } = useI18n();
  const router = useRouter();
  const declarations = useDeclarations();
  const [selected, setSelected] = useState<HrSelfDeclaration | null>(null);

  if (declarations.isPending) return <ActivityIndicator style={styles.loading} />;
  if (declarations.isError || !declarations.data) return <ErrorNote message={t.common.somethingWrong} />;

  const { declarations: rows, open } = declarations.data;
  const totals = open.filter((o) => o.pending > 0 || o.approved > 0);

  return (
    <>
      {totals.length > 0 ? (
        <View style={styles.totals}>
          <TotalCard label={t.expenses.awaiting} values={totals.map((o) => formatMoney(o.pending, o.currency, intlLocale))} />
          <TotalCard label={t.expenses.toBePaid} values={totals.map((o) => formatMoney(o.approved, o.currency, intlLocale))} />
        </View>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={<Receipt size={36} color={colors.mutedForeground} />}
          title={t.expenses.noExpenses}
          description={t.expenses.noExpensesDescription}
          action={
            canClaim ? <Button title={t.expenses.newExpense} onPress={() => router.push('/expense/new')} /> : undefined
          }
        />
      ) : (
        <Section>
          <Panel>
            {rows.map((row, index) => (
              <Pressable
                key={row.id}
                onPress={() => setSelected(row)}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.row,
                  index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                  pressed && { backgroundColor: colors.pressed },
                ]}
              >
                <View style={styles.rowText}>
                  <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
                    {row.description}
                  </Text>
                  <View style={styles.rowMeta}>
                    <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>
                      {labelFor(t.declarationCategory, row.category)} · {formatDay(row.expenseDate, intlLocale)}
                    </Text>
                    {row.hasReceipt ? <Paperclip size={12} color={colors.mutedForeground} /> : null}
                  </View>
                </View>
                <View style={styles.rowRight}>
                  <Text style={[styles.amount, { color: colors.text }]}>
                    {formatMoney(row.amount, row.currency, intlLocale)}
                  </Text>
                  <Pill label={labelFor(t.declarationStatus, row.status)} tone={statusTone(row.status)} />
                </View>
              </Pressable>
            ))}
          </Panel>
        </Section>
      )}

      {selected ? <DeclarationSheet declaration={selected} onClose={() => setSelected(null)} /> : null}
    </>
  );
}

function TotalCard({ label, values }: Readonly<{ label: string; values: string[] }>) {
  const { colors } = useTheme();
  return (
    <View style={[styles.totalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.totalLabel, { color: colors.mutedForeground }]}>{label}</Text>
      {values.map((value) => (
        <Text key={value} style={[styles.totalValue, { color: colors.text }]}>
          {value}
        </Text>
      ))}
    </View>
  );
}

function DeclarationSheet({ declaration, onClose }: Readonly<{ declaration: HrSelfDeclaration; onClose: () => void }>) {
  const { colors } = useTheme();
  const { t, format, intlLocale } = useI18n();
  const toast = useToast();
  const cancel = useCancelDeclaration();
  const [opening, setOpening] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const viewReceipt = async () => {
    setOpening(true);
    const ok = await openDocument({
      path: `/weldhr/me/declarations/${encodeURIComponent(declaration.id)}/receipt`,
      fileName: declaration.receiptFileName || `receipt-${declaration.expenseDate}.jpg`,
    });
    setOpening(false);
    if (!ok) toast.error(t.expenses.receiptFailed);
  };

  const withdraw = () => {
    cancel.mutate(declaration.id, {
      onSuccess: () => {
        toast.success(t.expenses.cancelled);
        onClose();
      },
      onError: (err) => toast.error((err as Error).message || t.common.somethingWrong),
    });
  };

  return (
    <Sheet visible onClose={onClose} title={declaration.description} heightRatio={0.6}>
      <View style={styles.sheet}>
        <Text style={[styles.sheetAmount, { color: colors.text }]}>
          {formatMoney(declaration.amount, declaration.currency, intlLocale)}
        </Text>
        <View style={styles.sheetMeta}>
          <Pill label={labelFor(t.declarationStatus, declaration.status)} tone={statusTone(declaration.status)} />
          <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>
            {labelFor(t.declarationCategory, declaration.category)} · {formatDate(declaration.expenseDate, intlLocale)}
          </Text>
        </View>
        {declaration.paidAt ? (
          <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>
            {format(t.expenses.paidOn, { date: formatDate(declaration.paidAt, intlLocale) })}
          </Text>
        ) : null}
        {declaration.reviewNote ? (
          <Text style={[styles.note, { color: colors.text }]}>
            {format(t.expenses.reviewNote, { note: declaration.reviewNote })}
          </Text>
        ) : null}

        {declaration.hasReceipt ? (
          <Button
            title={t.expenses.viewReceipt}
            variant="outline"
            leftIcon={<Paperclip size={16} color={colors.text} />}
            onPress={viewReceipt}
            loading={opening}
            fullWidth
          />
        ) : (
          <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>{t.expenses.noReceipt}</Text>
        )}

        {declaration.status === 'pending' ? (
          confirming ? (
            <View style={styles.confirm}>
              <Text style={[styles.confirmText, { color: colors.text }]}>{t.expenses.cancelTitle}</Text>
              <View style={styles.confirmButtons}>
                <Button title={t.expenses.keep} variant="secondary" onPress={() => setConfirming(false)} style={styles.flex} />
                <Button
                  title={t.expenses.cancelConfirm}
                  variant="destructive"
                  onPress={withdraw}
                  loading={cancel.isPending}
                  style={styles.flex}
                />
              </View>
            </View>
          ) : (
            <Button title={t.expenses.cancelConfirm} variant="ghost" onPress={() => setConfirming(true)} fullWidth />
          )
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { marginTop: 32 },
  totals: { flexDirection: 'row', gap: 10 },
  totalCard: { flex: 1, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 4 },
  totalLabel: { fontSize: 12, fontWeight: '500' },
  totalValue: { fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  rowText: { flex: 1, gap: 3 },
  rowTitle: { fontSize: 16, fontWeight: '600' },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowSub: { fontSize: 13 },
  rowRight: { alignItems: 'flex-end', gap: 6 },
  amount: { fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  sheet: { gap: 14, paddingBottom: 8 },
  sheetAmount: { fontSize: 32, fontWeight: '700', fontVariant: ['tabular-nums'] },
  sheetMeta: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  note: { fontSize: 14, fontStyle: 'italic' },
  confirm: { gap: 10 },
  confirmText: { fontSize: 15, fontWeight: '600', textAlign: 'center' },
  confirmButtons: { flexDirection: 'row', gap: 10 },
});
