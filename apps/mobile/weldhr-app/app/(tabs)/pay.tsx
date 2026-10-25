/**
 * Payslips and annual statements (jaaropgaaf / W-2). Opening one downloads
 * the PDF with the member's session; hr-api stamps the payslip as viewed and
 * audits it, which is why the "New" pill disappears after a refresh.
 */

import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronRight, FileText, Wallet } from 'lucide-react-native';
import type { HrAnnualStatement, HrMyPayslip } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { MyHrGate, useSelfState } from '@/components/MyHrGate';
import { Pill } from '@/components/Pill';
import { ErrorNote, Panel, Screen, Section } from '@/components/Screen';
import { BRAND } from '@/constants/brand';
import { useAnnualStatements, usePayslips } from '@/hooks/use-weldhr-queries';
import { formatDate, formatDateRange, formatMoney } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { openDocument } from '@/utils/open-document';

export default function PayScreen() {
  const { t } = useI18n();
  const state = useSelfState();
  const payslips = usePayslips();
  const statements = useAnnualStatements(payslips.data != null);

  return (
    <Screen
      title={t.pay.title}
      refreshing={payslips.isRefetching}
      onRefresh={() => {
        void payslips.refetch();
        void statements.refetch();
      }}
    >
      <MyHrGate state={state}>
        <PayBody />
      </MyHrGate>
    </Screen>
  );
}

function PayBody() {
  const { colors } = useTheme();
  const { t, format, intlLocale } = useI18n();
  const toast = useToast();
  const payslips = usePayslips();
  const statements = useAnnualStatements(payslips.data != null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  if (payslips.isPending) return <ActivityIndicator style={styles.loading} />;
  if (payslips.isError) return <ErrorNote message={t.common.somethingWrong} />;
  if (payslips.data == null) {
    return <EmptyState icon={<Wallet size={36} color={colors.mutedForeground} />} title={t.pay.notEnabled} />;
  }

  const open = async (id: string, path: string, fileName: string) => {
    setOpeningId(id);
    const ok = await openDocument({ path, fileName, mimeType: 'application/pdf' });
    setOpeningId(null);
    if (ok) void payslips.refetch();
    else toast.error(t.pay.openFailed);
  };

  const openPayslip = (slip: HrMyPayslip) =>
    open(
      slip.id,
      `/weldhr/me/payslips/${encodeURIComponent(slip.id)}/pdf`,
      `payslip-${slip.number ?? slip.periodEnd}.pdf`,
    );

  const openStatement = (statement: HrAnnualStatement) =>
    open(
      `${statement.year}-${statement.employerId}`,
      `/weldhr/me/annual-statements/${statement.year}?employerId=${encodeURIComponent(statement.employerId)}`,
      `${statement.kind}-${statement.year}.pdf`,
    );

  const [latest, ...older] = payslips.data;

  return (
    <>
      {latest ? (
        <Pressable
          onPress={() => void openPayslip(latest)}
          accessibilityRole="button"
          style={({ pressed }) => [styles.hero, { opacity: pressed ? 0.9 : 1 }]}
        >
          <View style={styles.heroTop}>
            <Text style={styles.heroLabel}>{formatDateRange(latest.periodStart, latest.periodEnd, intlLocale)}</Text>
            {latest.viewedAt ? null : (
              <View style={styles.heroPill}>
                <Text style={styles.heroPillText}>{t.pay.new}</Text>
              </View>
            )}
          </View>
          <Text style={styles.heroCaption}>{t.pay.netPay}</Text>
          <Text style={styles.heroAmount}>{formatMoney(latest.netPay, latest.currency, intlLocale)}</Text>
          <View style={styles.heroBottom}>
            <Text style={styles.heroMeta}>
              {format(t.pay.paidOn, { date: formatDate(latest.payDate, intlLocale) })} ·{' '}
              {format(t.pay.gross, { amount: formatMoney(latest.grossPay, latest.currency, intlLocale) })}
            </Text>
            {openingId === latest.id ? <ActivityIndicator color="#fff" /> : <FileText size={18} color="#fff" />}
          </View>
        </Pressable>
      ) : (
        <EmptyState
          icon={<Wallet size={36} color={colors.mutedForeground} />}
          title={t.pay.noPayslips}
          description={t.pay.noPayslipsDescription}
        />
      )}

      {older.length > 0 ? (
        <Section title={t.pay.payslips}>
          <Panel>
            {older.map((slip, index) => (
              <DocRow
                key={slip.id}
                first={index === 0}
                title={formatDateRange(slip.periodStart, slip.periodEnd, intlLocale)}
                subtitle={format(t.pay.paidOn, { date: formatDate(slip.payDate, intlLocale) })}
                value={formatMoney(slip.netPay, slip.currency, intlLocale)}
                isNew={!slip.viewedAt}
                busy={openingId === slip.id}
                onPress={() => void openPayslip(slip)}
              />
            ))}
          </Panel>
        </Section>
      ) : null}

      {statements.data && statements.data.length > 0 ? (
        <Section title={t.pay.annualStatements}>
          <Panel>
            {statements.data.map((statement, index) => (
              <DocRow
                key={`${statement.year}-${statement.employerId}`}
                first={index === 0}
                title={format(statement.kind === 'w2' ? t.pay.w2 : t.pay.jaaropgaaf, { year: statement.year })}
                subtitle={statement.employerName}
                busy={openingId === `${statement.year}-${statement.employerId}`}
                onPress={() => void openStatement(statement)}
              />
            ))}
          </Panel>
        </Section>
      ) : null}
    </>
  );
}

function DocRow({
  title,
  subtitle,
  value,
  isNew,
  busy,
  first,
  onPress,
}: Readonly<{
  title: string;
  subtitle: string;
  value?: string;
  isNew?: boolean;
  busy: boolean;
  first: boolean;
  onPress: () => void;
}>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
        pressed && { backgroundColor: colors.pressed },
      ]}
    >
      <FileText size={20} color={BRAND} />
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: colors.text }]}>{title}</Text>
        <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>{subtitle}</Text>
      </View>
      {isNew ? <Pill label={t.pay.new} tone="brand" /> : null}
      {value ? <Text style={[styles.rowValue, { color: colors.text }]}>{value}</Text> : null}
      {busy ? <ActivityIndicator /> : <ChevronRight size={18} color={colors.mutedForeground} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 32 },
  hero: { backgroundColor: BRAND, borderRadius: 18, padding: 18, gap: 2 },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  heroLabel: { color: '#fff', fontSize: 15, fontWeight: '600' },
  heroPill: { backgroundColor: '#fff', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  heroPillText: { color: BRAND, fontSize: 12, fontWeight: '700' },
  heroCaption: { color: 'rgba(255,255,255,0.8)', fontSize: 13 },
  heroAmount: { color: '#fff', fontSize: 36, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: -0.5 },
  heroBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 },
  heroMeta: { color: 'rgba(255,255,255,0.85)', fontSize: 13, flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowSub: { fontSize: 13 },
  rowValue: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
