/**
 * The Expenses tab: the member's own declarations, and for people who approve
 * expenses a second tab with the ones waiting for them. Each list has a
 * search field on top that narrows it as you type, and beside it a filter
 * button whose sheet switches statuses (own claims) or categories (claims to
 * approve) on and off.
 */

import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Paperclip } from 'lucide-react-native';
import type { HrDeclarationListItem } from '@weldsuite/app-api-client/domains/weldhr';

import { ExpenseApprovals } from '@/components/Approvals';
import { EmptyState } from '@/components/EmptyState';
import { FilterSheet } from '@/components/FilterSheet';
import { GroupedList } from '@/components/GroupedList';
import { CategoryTile, statusColor } from '@/components/HrRows';
import { MyHrGate, useSelfState } from '@/components/MyHrGate';
import { QueryBody } from '@/components/QueryBody';
import { Card, DetailRow, Row } from '@/components/Row';
import { ListSearch, NoMatches } from '@/components/ListSearch';
import { Inset, Screen, Section, TabStrip, type SegmentOption } from '@/components/Screen';
import { usePalette } from '@/hooks/use-palette';
import { useDeclarations, useHrAccess, usePendingExpenses } from '@/hooks/use-weldhr-queries';
import { filterChoices, isFiltered, NO_FILTER, passesFilter, type ExpenseFilter } from '@/lib/expense-filter';
import { formatDay, formatMoney, withCount } from '@/lib/format';
import { labelFor, useI18n } from '@/lib/i18n';
import { matchesSearch } from '@/lib/search';

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
      segments={<TabStrip value={view} options={options} onChange={setChosen} />}
      refreshing={declarations.isRefetching || pending.isRefetching}
      onRefresh={refresh}
    >
      {/* Keyed by the tab, so the other list fades in instead of popping in. */}
      <Animated.View key={view} entering={FadeIn.duration(180)} style={styles.view}>
        {view === 'mine' ? (
          <MyHrGate state={state} onRetry={refresh}>
            <MyExpenses canClaim={canClaim} turnedOff={state.status === 'ready' && !state.self.features.declarations} />
          </MyHrGate>
        ) : (
          <QueryBody query={pending}>
            {(rows) =>
              rows.length === 0 ? (
                <EmptyState
                  illustration="check"
                  title={t.team.nothingToApprove}
                  description={t.team.nothingToApproveDescription}
                />
              ) : (
                <ExpensesToApprove declarations={rows} />
              )
            }
          </QueryBody>
        )}
      </Animated.View>
    </Screen>
  );
}

/** The claims waiting for this approver, searchable by who made them and what for, filterable by category. */
function ExpensesToApprove({ declarations }: Readonly<{ declarations: HrDeclarationListItem[] }>) {
  const { t, intlLocale } = useI18n();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ExpenseFilter>(NO_FILTER);
  const [filtering, setFiltering] = useState(false);
  const shown = declarations.filter(
    (row) =>
      passesFilter(filter, row) &&
      matchesSearch(search, [
        row.employeeName,
        row.description,
        labelFor(t.declarationCategory, row.category),
        formatMoney(row.amount, row.currency, intlLocale),
        formatDay(row.expenseDate, intlLocale),
      ]),
  );

  return (
    <>
      <ListSearch
        value={search}
        onChangeText={setSearch}
        placeholder={t.expenses.search}
        filtered={isFiltered(filter)}
        onFilter={() => setFiltering(true)}
        testID="approvals"
      />
      {shown.length === 0 ? (
        <NoMatches
          title={t.expenses.noResults}
          description={t.expenses.noResultsDescription}
          filtered={isFiltered(filter)}
          onClearFilters={() => setFilter(NO_FILTER)}
          onClearSearch={() => setSearch('')}
        />
      ) : (
        <ExpenseApprovals declarations={shown} />
      )}
      {filtering ? (
        <FilterSheet
          options={filterChoices(declarations, filter).categories.map((category) => ({
            value: category,
            label: labelFor(t.declarationCategory, category),
          }))}
          off={filter.categories}
          onApply={(categories) => setFilter({ ...filter, categories })}
          onClose={() => setFiltering(false)}
        />
      ) : null}
    </>
  );
}

function MyExpenses({ canClaim, turnedOff }: Readonly<{ canClaim: boolean; turnedOff: boolean }>) {
  const palette = usePalette();
  const { t, intlLocale } = useI18n();
  const router = useRouter();
  const declarations = useDeclarations();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ExpenseFilter>(NO_FILTER);
  const [filtering, setFiltering] = useState(false);

  return (
    <QueryBody query={declarations}>
      {({ declarations: rows, open }) => {
        const totals = open.filter((o) => o.pending > 0 || o.approved > 0);
        // While searching or filtering the totals step aside, so the matches sit right under the field.
        const showTotals = totals.length > 0 && search.trim().length === 0 && !isFiltered(filter);
        const shown = rows.filter(
          (row) =>
            passesFilter(filter, row) &&
            matchesSearch(search, [
              row.description,
              labelFor(t.declarationCategory, row.category),
              labelFor(t.declarationStatus, row.status),
              formatMoney(row.amount, row.currency, intlLocale),
              formatDay(row.expenseDate, intlLocale),
            ]),
        );
        return (
          <>
            {turnedOff ? (
              <Inset style={styles.note}>
                <Text style={[styles.noteText, { color: palette.muted }]}>{t.expenses.turnedOff}</Text>
              </Inset>
            ) : null}

            {rows.length > 0 ? (
              <ListSearch
                value={search}
                onChangeText={setSearch}
                placeholder={t.expenses.search}
                filtered={isFiltered(filter)}
                onFilter={() => setFiltering(true)}
                testID="expenses"
              />
            ) : null}

            {showTotals ? (
              <Section first style={styles.afterSearch}>
                {/* The search field's border, colour and width, so the two sit together. */}
                <Card style={[styles.totals, { borderColor: palette.softBorder }]}>
                  <DetailRow
                    smallLabel
                    label={t.expenses.awaiting}
                    value={totals.map((o) => formatMoney(o.pending, o.currency, intlLocale)).join(' · ')}
                  />
                  <DetailRow
                    smallLabel
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
                action={
                  canClaim ? { label: t.expenses.newExpense, onPress: () => router.push('/expense/new') } : undefined
                }
              />
            ) : shown.length === 0 ? (
              <NoMatches
                title={t.expenses.noResults}
                description={t.expenses.noResultsDescription}
                filtered={isFiltered(filter)}
                onClearFilters={() => setFilter(NO_FILTER)}
                onClearSearch={() => setSearch('')}
              />
            ) : (
              // Absence's list: the status in its colour under the title, the amount and the day on the right.
              <GroupedList
                groups={[
                  {
                    key: 'declarations',
                    title: t.expenses.declarations,
                    figure: String(shown.length),
                    children: shown.map((row) => (
                      <Row
                        key={row.id}
                        leading={<CategoryTile category={row.category} />}
                        title={row.description}
                        titleLines={1}
                        subtitle={labelFor(t.declarationStatus, row.status)}
                        subtitleColor={statusColor(row.status, palette)}
                        subtitleIcon={row.hasReceipt ? <Paperclip size={13} color={palette.muted} /> : null}
                        value={formatMoney(row.amount, row.currency, intlLocale)}
                        detail={formatDay(row.expenseDate, intlLocale)}
                        muted={row.status === 'cancelled'}
                        onPress={() => router.push({ pathname: '/expense/[id]', params: { id: row.id } })}
                      />
                    )),
                  },
                ]}
              />
            )}

            {filtering ? (
              <FilterSheet
                options={filterChoices(rows, filter).statuses.map((status) => ({
                  value: status,
                  label: labelFor(t.declarationStatus, status),
                }))}
                off={filter.statuses}
                onApply={(statuses) => setFilter({ ...filter, statuses })}
                onClose={() => setFiltering(false)}
              />
            ) : null}
          </>
        );
      }}
    </QueryBody>
  );
}

const styles = StyleSheet.create({
  // Grows like the page does, so an empty state still centres in it.
  view: { flexGrow: 1 },
  afterSearch: { marginTop: 14 },
  // A full point, like the search field, instead of the cards' hairline.
  totals: { borderWidth: 1 },
  note: { marginTop: 8 },
  noteText: { fontSize: 14, lineHeight: 20 },
});
