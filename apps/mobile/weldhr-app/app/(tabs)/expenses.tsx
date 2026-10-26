/**
 * The Expenses tab: the member's own declarations, and for people who approve
 * expenses a second view with the ones waiting for them.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  BedDouble,
  Car,
  GraduationCap,
  Laptop,
  Paperclip,
  Receipt,
  UtensilsCrossed,
} from 'lucide-react-native';
import type { HrDeclarationCategory, HrSelfDeclaration } from '@weldsuite/app-api-client/domains/weldhr';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { ExpenseApprovals } from '@/components/Approvals';
import { EmptyState } from '@/components/EmptyState';
import { statusColor } from '@/components/HrRows';
import { MyHrGate, useSelfState } from '@/components/MyHrGate';
import { QueryBody } from '@/components/QueryBody';
import { Card, DetailRow, IconTile, List, Row } from '@/components/Row';
import { Inset, Screen, Section, Segments, type SegmentOption } from '@/components/Screen';
import { usePalette } from '@/hooks/use-palette';
import { useCancelDeclaration, useDeclarations, useHrAccess, usePendingExpenses } from '@/hooks/use-weldhr-queries';
import { formatDate, formatDay, formatMoney, withCount } from '@/lib/format';
import { labelFor, useI18n } from '@/lib/i18n';
import { openDocument } from '@/utils/open-document';

/** An icon per category, so a list of claims scans without reading. */
const CATEGORY_ICONS: Record<HrDeclarationCategory, typeof Receipt> = {
  travel: Car,
  meals: UtensilsCrossed,
  accommodation: BedDouble,
  equipment: Laptop,
  training: GraduationCap,
  other: Receipt,
};

type ExpensesView = 'mine' | 'approve';

export default function ExpensesScreen() {
  const { t } = useI18n();
  const params = useLocalSearchParams<{ view?: string }>();
  const { access } = useHrAccess();
  const state = useSelfState();
  const declarations = useDeclarations();
  const pending = usePendingExpenses(access.approveExpenses);
  const [chosen, setChosen] = useState<ExpensesView>(params.view === 'approve' ? 'approve' : 'mine');
  const canClaim = state.status === 'ready' && state.self.features.declarations;

  const options: SegmentOption<ExpensesView>[] = [];
  if (access.self) options.push({ value: 'mine', label: t.expenses.mine });
  if (access.approveExpenses) {
    options.push({ value: 'approve', label: withCount(t.expenses.toApprove, pending.data?.length ?? 0) });
  }
  const view = options.some((o) => o.value === chosen) ? chosen : (options[0]?.value ?? 'mine');

  const refresh = () => {
    state.refetch();
    void declarations.refetch();
    void pending.refetch();
  };

  return (
    <Screen
      title={t.expenses.title}
      plain
      segments={<Segments value={view} options={options} onChange={setChosen} />}
      refreshing={declarations.isRefetching || pending.isRefetching}
      onRefresh={refresh}
    >
      {view === 'mine' ? (
        <MyHrGate state={state} onRetry={refresh}>
          <MyExpenses canClaim={canClaim} turnedOff={state.status === 'ready' && !state.self.features.declarations} />
        </MyHrGate>
      ) : (
        <QueryBody query={pending}>
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState illustration="check" title={t.team.nothingToApprove} description={t.team.nothingToApproveDescription} />
            ) : (
              <ExpenseApprovals declarations={rows} />
            )
          }
        </QueryBody>
      )}
    </Screen>
  );
}

function MyExpenses({ canClaim, turnedOff }: Readonly<{ canClaim: boolean; turnedOff: boolean }>) {
  const palette = usePalette();
  const { t, intlLocale } = useI18n();
  const router = useRouter();
  const declarations = useDeclarations();
  const [selected, setSelected] = useState<HrSelfDeclaration | null>(null);

  return (
    <QueryBody query={declarations}>
      {({ declarations: rows, open }) => {
        const totals = open.filter((o) => o.pending > 0 || o.approved > 0);
        return (
          <>
            {turnedOff ? (
              <Inset style={styles.note}>
                <Text style={[styles.noteText, { color: palette.muted }]}>{t.expenses.turnedOff}</Text>
              </Inset>
            ) : null}

            {totals.length > 0 ? (
              <Section first>
                <Card>
                  <DetailRow
                    label={t.expenses.awaiting}
                    value={totals.map((o) => formatMoney(o.pending, o.currency, intlLocale)).join(' · ')}
                  />
                  <DetailRow
                    label={t.expenses.toBePaid}
                    value={totals.map((o) => formatMoney(o.approved, o.currency, intlLocale)).join(' · ')}
                  />
                </Card>
              </Section>
            ) : null}

            {rows.length === 0 ? (
              <EmptyState
                illustration="receipt"
                title={t.expenses.noExpenses}
                description={t.expenses.noExpensesDescription}
                action={canClaim ? { label: t.expenses.newExpense, onPress: () => router.push('/expense/new') } : undefined}
              />
            ) : (
              <Section title={t.expenses.declarations} first={totals.length === 0}>
                <List>
                  {rows.map((row) => (
                    <Row
                      key={row.id}
                      leading={<IconTile icon={CATEGORY_ICONS[row.category] ?? Receipt} />}
                      title={row.description}
                      subtitle={`${labelFor(t.declarationCategory, row.category)} • ${formatDay(row.expenseDate, intlLocale)}`}
                      subtitleIcon={row.hasReceipt ? <Paperclip size={13} color={palette.muted} /> : null}
                      value={formatMoney(row.amount, row.currency, intlLocale)}
                      detail={labelFor(t.declarationStatus, row.status)}
                      detailColor={statusColor(row.status, palette)}
                      muted={row.status === 'cancelled'}
                      onPress={() => setSelected(row)}
                    />
                  ))}
                </List>
              </Section>
            )}

            {selected ? <DeclarationSheet declaration={selected} onClose={() => setSelected(null)} /> : null}
          </>
        );
      }}
    </QueryBody>
  );
}

function DeclarationSheet({ declaration, onClose }: Readonly<{ declaration: HrSelfDeclaration; onClose: () => void }>) {
  const palette = usePalette();
  const { t, format, intlLocale } = useI18n();
  const toast = useToast();
  const cancel = useCancelDeclaration();
  const [opening, setOpening] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const Icon = CATEGORY_ICONS[declaration.category] ?? Receipt;

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
        <View style={styles.sheetTop}>
          <IconTile icon={Icon} size={46} />
          <View style={styles.flex}>
            <Text style={[styles.sheetAmount, { color: palette.text }]}>
              {formatMoney(declaration.amount, declaration.currency, intlLocale)}
            </Text>
            <Text style={[styles.sheetSub, { color: palette.muted }]}>
              {labelFor(t.declarationCategory, declaration.category)} • {formatDate(declaration.expenseDate, intlLocale)}
            </Text>
          </View>
          <Text style={[styles.sheetStatus, { color: statusColor(declaration.status, palette) }]}>
            {labelFor(t.declarationStatus, declaration.status)}
          </Text>
        </View>
        {declaration.paidAt ? (
          <Text style={[styles.sheetSub, { color: palette.muted }]}>
            {format(t.expenses.paidOn, { date: formatDate(declaration.paidAt, intlLocale) })}
          </Text>
        ) : null}
        {declaration.reviewNote ? (
          <View style={[styles.note, styles.noteBox, { backgroundColor: palette.tile }]}>
            <Text style={[styles.noteText, { color: palette.text }]}>
              {format(t.expenses.reviewNote, { note: declaration.reviewNote })}
            </Text>
          </View>
        ) : null}

        {declaration.hasReceipt ? (
          <Button
            title={t.expenses.viewReceipt}
            variant="secondary"
            leftIcon={<Paperclip size={16} color={palette.text} />}
            onPress={viewReceipt}
            loading={opening}
            fullWidth
          />
        ) : (
          <Text style={[styles.sheetSub, { color: palette.muted }]}>{t.expenses.noReceipt}</Text>
        )}

        {declaration.status === 'pending' && confirming ? (
          <View style={styles.confirm}>
            <Text style={[styles.confirmText, { color: palette.text }]}>{t.expenses.cancelTitle}</Text>
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
        ) : null}
        {declaration.status === 'pending' && !confirming ? (
          <Button title={t.expenses.cancelConfirm} variant="ghost" onPress={() => setConfirming(true)} fullWidth />
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  note: { marginTop: 8 },
  noteBox: { borderRadius: 12, padding: 12, marginTop: 0 },
  noteText: { fontSize: 14, lineHeight: 20 },
  sheet: { gap: 16, paddingBottom: 8 },
  sheetTop: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  sheetAmount: { fontSize: 26, fontWeight: '700', letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
  sheetSub: { fontSize: 14, marginTop: 2 },
  sheetStatus: { fontSize: 15, fontWeight: '600' },
  confirm: { gap: 10 },
  confirmText: { fontSize: 15, fontWeight: '600', textAlign: 'center' },
  confirmButtons: { flexDirection: 'row', gap: 10 },
});
