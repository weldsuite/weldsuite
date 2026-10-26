/**
 * Payslips and annual statements (jaaropgaaf / W-2). Opening one downloads
 * the PDF with the member's session; hr-api stamps the payslip as viewed and
 * audits it, which is why the "New" pill disappears after a refresh.
 */

import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronRight, FileText } from 'lucide-react-native';
import type { HrAnnualStatement, HrMyPayslip } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { EmptyState } from '@/components/EmptyState';
import { MyHrGate, useSelfState } from '@/components/MyHrGate';
import { QueryBody } from '@/components/QueryBody';
import { IconTile, List, Row } from '@/components/Row';
import { Screen, Section } from '@/components/Screen';
import { usePalette } from '@/hooks/use-palette';
import { useAnnualStatements, usePayslips } from '@/hooks/use-weldhr-queries';
import { formatDate, formatDateRange, formatMoney } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { openDocument } from '@/utils/open-document';

export default function PayScreen() {
  const { t } = useI18n();
  const state = useSelfState();
  const payslips = usePayslips();
  const statements = useAnnualStatements(payslips.data != null);

  const refresh = () => {
    void payslips.refetch();
    void statements.refetch();
  };

  return (
    <Screen title={t.pay.payslips} variant="push" refreshing={payslips.isRefetching} onRefresh={refresh}>
      <MyHrGate state={state} onRetry={refresh}>
        <PayBody />
      </MyHrGate>
    </Screen>
  );
}

function PayBody() {
  const palette = usePalette();
  const { t, format, intlLocale } = useI18n();
  const toast = useToast();
  const payslips = usePayslips();
  const statements = useAnnualStatements(payslips.data != null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const open = async (id: string, path: string, fileName: string) => {
    setOpeningId(id);
    const ok = await openDocument({ path, fileName, mimeType: 'application/pdf' });
    setOpeningId(null);
    if (ok) void payslips.refetch();
    else toast.error(t.pay.openFailed);
  };

  const openPayslip = (slip: HrMyPayslip) =>
    open(slip.id, `/weldhr/me/payslips/${encodeURIComponent(slip.id)}/pdf`, `payslip-${slip.number ?? slip.periodEnd}.pdf`);

  const openStatement = (statement: HrAnnualStatement) =>
    open(
      `${statement.year}-${statement.employerId}`,
      `/weldhr/me/annual-statements/${statement.year}?employerId=${encodeURIComponent(statement.employerId)}`,
      `${statement.kind}-${statement.year}.pdf`,
    );

  return (
    <QueryBody query={payslips}>
      {(slips) => {
        // `null` is hr-api's 404: payroll is off for this workspace.
        if (slips == null) return <EmptyState illustration="document" title={t.pay.notEnabled} />;
        const [latest, ...older] = slips;
        return (
          <>
            {latest ? (
              <LatestPayslip slip={latest} busy={openingId === latest.id} onPress={() => void openPayslip(latest)} />
            ) : (
              <EmptyState illustration="document" title={t.pay.noPayslips} description={t.pay.noPayslipsDescription} />
            )}

            {older.length > 0 ? (
              <Section title={t.pay.earlier}>
                <List>
                  {older.map((slip) => (
                    <Row
                      key={slip.id}
                      leading={<IconTile icon={FileText} />}
                      title={formatDateRange(slip.periodStart, slip.periodEnd, intlLocale)}
                      subtitle={format(t.pay.paidOn, { date: formatDate(slip.payDate, intlLocale) })}
                      value={formatMoney(slip.netPay, slip.currency, intlLocale)}
                      detail={slip.viewedAt ? undefined : t.pay.new}
                      detailColor={palette.accent}
                      disabled={openingId === slip.id}
                      onPress={() => void openPayslip(slip)}
                    />
                  ))}
                </List>
              </Section>
            ) : null}

            {statements.data && statements.data.length > 0 ? (
              <Section title={t.pay.annualStatements}>
                <List>
                  {statements.data.map((statement) => {
                    const id = `${statement.year}-${statement.employerId}`;
                    return (
                      <Row
                        key={id}
                        leading={<IconTile icon={FileText} />}
                        title={format(statement.kind === 'w2' ? t.pay.w2 : t.pay.jaaropgaaf, { year: statement.year })}
                        subtitle={statement.employerName}
                        disabled={openingId === id}
                        onPress={() => void openStatement(statement)}
                        chevron
                      />
                    );
                  })}
                </List>
              </Section>
            ) : null}
          </>
        );
      }}
    </QueryBody>
  );
}

/** The newest payslip, large: what most people come here for. */
function LatestPayslip({ slip, busy, onPress }: Readonly<{ slip: HrMyPayslip; busy: boolean; onPress: () => void }>) {
  const palette = usePalette();
  const { t, format, intlLocale } = useI18n();
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.hero,
        { backgroundColor: palette.surface, borderColor: palette.border, opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <View style={styles.heroTop}>
        <Text style={[styles.heroLabel, { color: palette.muted }]}>{t.pay.latest}</Text>
        {slip.viewedAt ? null : <Text style={[styles.heroNew, { color: palette.accent }]}>{t.pay.new}</Text>}
      </View>
      <Text style={[styles.heroPeriod, { color: palette.text }]}>{formatDateRange(slip.periodStart, slip.periodEnd, intlLocale)}</Text>
      <Text style={[styles.heroCaption, { color: palette.muted }]}>{t.pay.netPay}</Text>
      <Text style={[styles.heroAmount, { color: palette.text }]}>{formatMoney(slip.netPay, slip.currency, intlLocale)}</Text>
      <View style={[styles.heroBottom, { borderTopColor: palette.border }]}>
        <Text style={[styles.heroMeta, { color: palette.muted }]} numberOfLines={1}>
          {format(t.pay.paidOn, { date: formatDate(slip.payDate, intlLocale) })} ·{' '}
          {format(t.pay.gross, { amount: formatMoney(slip.grossPay, slip.currency, intlLocale) })}
        </Text>
        {busy ? <ActivityIndicator color={palette.muted} /> : <ChevronRight size={20} color={palette.text} />}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hero: { marginHorizontal: 16, marginTop: 8, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 16 },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  heroLabel: { fontSize: 15 },
  heroNew: { fontSize: 15, fontWeight: '600' },
  heroPeriod: { fontSize: 18, fontWeight: '700', letterSpacing: -0.3, marginTop: 2 },
  heroCaption: { fontSize: 15, marginTop: 18 },
  heroAmount: { fontSize: 34, fontWeight: '700', letterSpacing: -0.8, fontVariant: ['tabular-nums'] },
  heroBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  heroMeta: { fontSize: 14, flex: 1 },
});
