/**
 * One of my expense claims, opened from Expenses: the claim as its row, the
 * facts (amount, category, day, when it was sent, reviewed and paid, HR's
 * note), the receipt to open, and withdrawing it while it waits for a
 * decision. Laid out as a leave request's page.
 */

import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Paperclip } from 'lucide-react-native';
import type { HrSelfDeclarations } from '@weldsuite/app-api-client/domains/weldhr';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { EmptyState } from '@/components/EmptyState';
import { CategoryTile, statusColor } from '@/components/HrRows';
import { QueryBody } from '@/components/QueryBody';
import { Card, DetailRow, IconTile, Row } from '@/components/Row';
import { Screen, Section } from '@/components/Screen';
import { usePalette } from '@/hooks/use-palette';
import { useCancelDeclaration, useDeclarations } from '@/hooks/use-weldhr-queries';
import { formatDate, formatDay, formatMoney } from '@/lib/format';
import { labelFor, useI18n } from '@/lib/i18n';
import { openDocument } from '@/utils/open-document';

export default function ExpenseScreen() {
  const { t } = useI18n();
  const { id } = useLocalSearchParams<{ id: string }>();
  const declarations = useDeclarations();
  const declaration = declarations.data?.declarations.find((d) => d.id === id);

  return (
    <Screen
      title={declaration?.description ?? t.expenseDetail.title}
      variant="push"
      plain
      refreshing={declarations.isRefetching}
      onRefresh={() => void declarations.refetch()}
    >
      <QueryBody query={declarations}>{(data) => <ExpenseDetail data={data} id={id} />}</QueryBody>
    </Screen>
  );
}

function ExpenseDetail({ data, id }: Readonly<{ data: HrSelfDeclarations; id: string }>) {
  const palette = usePalette();
  const { t, intlLocale } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const cancel = useCancelDeclaration();
  const [confirming, setConfirming] = useState(false);
  const [opening, setOpening] = useState(false);

  const declaration = data.declarations.find((d) => d.id === id);
  if (!declaration) return <EmptyState illustration="receipt" title={t.expenseDetail.notFound} />;

  const amount = formatMoney(declaration.amount, declaration.currency, intlLocale);
  const facts = [
    { label: t.expenseForm.amount, value: amount },
    { label: t.expenseForm.category, value: labelFor(t.declarationCategory, declaration.category) },
    { label: t.expenseForm.date, value: formatDate(declaration.expenseDate, intlLocale) },
    { label: t.expenseDetail.submitted, value: formatDate(declaration.createdAt, intlLocale) },
    { label: t.expenseDetail.reviewed, value: declaration.reviewedAt ? formatDate(declaration.reviewedAt, intlLocale) : null },
    { label: t.expenseDetail.paid, value: declaration.paidAt ? formatDate(declaration.paidAt, intlLocale) : null },
    { label: t.expenseDetail.note, value: declaration.reviewNote },
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact.value));

  const viewReceipt = async () => {
    setOpening(true);
    const ok = await openDocument({
      path: `/weldhr/me/declarations/${encodeURIComponent(declaration.id)}/receipt`,
      fileName: declaration.receiptFileName || `receipt-${declaration.expenseDate}.jpg`,
    });
    setOpening(false);
    if (!ok) toast.error(t.expenses.receiptFailed);
  };

  return (
    <>
      <Section first>
        <Card open>
          <Row
            leading={<CategoryTile category={declaration.category} />}
            title={declaration.description}
            titleLines={2}
            subtitle={labelFor(t.declarationStatus, declaration.status)}
            subtitleColor={statusColor(declaration.status, palette)}
            value={amount}
            detail={formatDay(declaration.expenseDate, intlLocale)}
            muted={declaration.status === 'cancelled'}
          />
        </Card>
      </Section>

      <Section title={t.expenseDetail.title}>
        <Card open>
          {facts.map((fact) => (
            <DetailRow key={fact.label} label={fact.label} value={fact.value} />
          ))}
        </Card>
      </Section>

      <Section title={t.expenseForm.receipt}>
        <Card open>
          {declaration.hasReceipt ? (
            <Row
              leading={<IconTile icon={Paperclip} />}
              title={t.expenses.viewReceipt}
              subtitle={declaration.receiptFileName}
              value={opening ? <ActivityIndicator size="small" color={palette.muted} /> : undefined}
              onPress={() => void viewReceipt()}
              disabled={opening}
              chevron
              testID="expense-receipt"
            />
          ) : (
            <Row leading={<IconTile icon={Paperclip} />} title={t.expenses.noReceipt} regular muted />
          )}
        </Card>
      </Section>

      {declaration.status === 'pending' ? (
        <View style={styles.actions}>
          <Button
            title={t.expenses.cancelConfirm}
            variant="destructive"
            onPress={() => setConfirming(true)}
            fullWidth
            testID="expense-cancel"
          />
        </View>
      ) : null}

      <ConfirmModal
        visible={confirming}
        title={t.expenses.cancelTitle}
        message={`${declaration.description} · ${amount}`}
        confirmText={t.expenses.cancelConfirm}
        cancelText={t.expenses.keep}
        variant="destructive"
        loading={cancel.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          cancel.mutate(declaration.id, {
            onSuccess: () => {
              toast.success(t.expenses.cancelled);
              setConfirming(false);
              router.back();
            },
            onError: (err) => {
              toast.error((err as Error).message || t.common.somethingWrong);
              setConfirming(false);
            },
          })
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  actions: { paddingHorizontal: 16, marginTop: 28 },
});
