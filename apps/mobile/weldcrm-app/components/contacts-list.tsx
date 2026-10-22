/**
 * The Companies and People tabs: search, the web's All / Leads / Suppliers
 * filter, and full-bleed rows like WeldFlow's lists. Long press a row for
 * call, email, edit, archive and delete.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Linking, RefreshControl, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Building2, Plus, Users } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Chip } from '@weldsuite/mobile-ui/components/Chip';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { SearchBar } from '@weldsuite/mobile-ui/components/SearchBar';
import { TabHeader } from '@/components/headers';
import { OptionSheet } from '@/components/option-sheet';
import { InitialsTile, Pill, RecordRow } from '@/components/record-row';
import { usePagedList } from '@/hooks/use-paged-list';
import { api, type CompanyRecord, type PersonRecord } from '@/services/api';
import { interpolate, labelFor, useI18n } from '@/lib/i18n';

export type Segment = 'people' | 'companies';
/** The web's People/Companies `filter`: a lead or a supplier is a flag on the record. */
type Filter = 'all' | 'leads' | 'suppliers';
type RowAction = 'call' | 'email' | 'edit' | 'archive' | 'delete';

/** What the row action sheet needs about the record it was opened for. */
interface ActionTarget {
  kind: Segment;
  id: string;
  name: string;
  email?: string;
  phone?: string;
  archived: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  active: '#10B981',
  lead: '#3B82F6',
  prospect: '#F59E0B',
  customer: '#10B981',
  inactive: '#9CA3AF',
  churned: '#EF4444',
};

const statusColor = (status?: string) => STATUS_COLORS[status?.toLowerCase() ?? ''] ?? '#6B7280';

type ListRecord = Pick<PersonRecord, 'id' | 'name' | 'email' | 'phone' | 'mobile' | 'archivedAt'>;

const targetOf = (kind: Segment, item: ListRecord): ActionTarget => ({
  kind,
  id: item.id,
  name: item.name,
  email: item.email || undefined,
  phone: item.phone ?? item.mobile,
  archived: !!item.archivedAt,
});

/** Empty-list copy: a load error wins, and a search or filter drops the hint. */
function useEmptyCopy(isPeople: boolean, failed: boolean, narrowed: boolean) {
  const { t } = useI18n();
  if (failed) return { emptyTitle: t.contacts.loadFailed, emptyText: t.common.pullToRetry };
  const hint = isPeople ? t.contacts.emptyPeopleHint : t.contacts.emptyCompaniesHint;
  return {
    emptyTitle: isPeople ? t.contacts.emptyPeople : t.contacts.emptyCompanies,
    emptyText: narrowed ? undefined : hint,
  };
}

export function ContactsList({ segment }: Readonly<{ segment: Segment }>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [actionTarget, setActionTarget] = useState<ActionTarget | null>(null);
  const params = useLocalSearchParams<{ filter?: string }>();

  // Other screens can land here with ?filter=leads.
  useEffect(() => {
    if (!params.filter) return;
    if (params.filter === 'all' || params.filter === 'leads' || params.filter === 'suppliers') setFilter(params.filter);
    router.setParams({ filter: undefined });
  }, [params.filter]);

  const fetchPeople = useCallback(
    (page: { cursor: string | null; search: string }) =>
      api.getPeople({ ...page, isLead: filter === 'leads', isSupplier: filter === 'suppliers' }),
    [filter],
  );
  const fetchCompanies = useCallback(
    (page: { cursor: string | null; search: string }) =>
      api.getCompanies({ ...page, isLead: filter === 'leads', isSupplier: filter === 'suppliers' }),
    [filter],
  );

  const people = usePagedList<PersonRecord>(fetchPeople, { search, enabled: segment === 'people', resetKey: filter });
  const companies = usePagedList<CompanyRecord>(fetchCompanies, { search, enabled: segment === 'companies', resetKey: filter });
  const active = segment === 'people' ? people : companies;

  useEffect(() => {
    if (active.error) toast.error(t.contacts.loadFailed);
  }, [active.error, t, toast]);

  const openRecord = (id: string, name: string, edit?: boolean) => {
    router.push({
      pathname: segment === 'people' ? '/person/[id]' : '/company/[id]',
      params: { id, name, ...(edit ? { edit: 'true' } : {}) },
    });
  };

  const archive = async (target: ActionTarget) => {
    const next = !target.archived;
    if (target.kind === 'people') {
      const res = await api.setPersonArchived(target.id, next);
      if (!res.success || !res.data) return toast.error(t.records.archiveFailed);
      people.updateItem(res.data);
    } else {
      const res = await api.setCompanyArchived(target.id, next);
      if (!res.success || !res.data) return toast.error(t.records.archiveFailed);
      companies.updateItem(res.data);
    }
    toast.success(next ? t.records.archivedToast : t.records.unarchivedToast);
  };

  const remove = async (target: ActionTarget) => {
    const copy = target.kind === 'people' ? t.person : t.company;
    const res = target.kind === 'people' ? await api.deletePerson(target.id) : await api.deleteCompany(target.id);
    if (!res.success) {
      toast.error(typeof res.error === 'string' ? res.error : t.contacts.deleteFailed);
      return;
    }
    (target.kind === 'people' ? people : companies).removeItem(target.id);
    toast.success(copy.deletedToast);
  };

  const runAction = (action: RowAction | null) => {
    const target = actionTarget;
    setActionTarget(null);
    if (!target || !action) return;
    if (action === 'call' && target.phone) void Linking.openURL(`tel:${target.phone}`);
    if (action === 'email' && target.email) void Linking.openURL(`mailto:${target.email}`);
    if (action === 'edit') openRecord(target.id, target.name, true);
    if (action === 'archive') void archive(target);
    if (action === 'delete') {
      const copy = target.kind === 'people' ? t.person : t.company;
      Alert.alert(copy.deleteTitle, interpolate(copy.deleteMessage, { name: target.name }), [
        { text: t.common.cancel, style: 'cancel' },
        { text: t.common.delete, style: 'destructive', onPress: () => void remove(target) },
      ]);
    }
  };

  const flagsOf = (record: { isLead: boolean; isSupplier: boolean; archivedAt?: string }) =>
    [
      record.isLead ? t.records.isLead : '',
      record.isSupplier ? t.records.isSupplier : '',
      record.archivedAt ? t.records.archived : '',
    ].filter(Boolean);

  const badgeFor = (status?: string) =>
    status ? <Pill label={labelFor(t.status, status)} color={statusColor(status)} /> : undefined;

  const actionOptions = actionTarget
    ? [
        ...(actionTarget.phone ? [{ value: 'call' as const, label: t.common.call }] : []),
        ...(actionTarget.email ? [{ value: 'email' as const, label: t.common.email }] : []),
        { value: 'edit' as const, label: t.common.edit },
        { value: 'archive' as const, label: actionTarget.archived ? t.records.unarchive : t.records.archive },
        { value: 'delete' as const, label: t.common.delete, color: colors.destructive },
      ]
    : [];

  const isPeople = segment === 'people';
  const EmptyIcon = isPeople ? Users : Building2;
  const { emptyTitle, emptyText } = useEmptyCopy(isPeople, !!active.error, !!search || filter !== 'all');

  const listProps = {
    contentContainerStyle: active.items.length === 0 ? styles.emptyContainer : undefined,
    refreshControl: <RefreshControl refreshing={active.refreshing} onRefresh={() => void active.refresh()} />,
    onEndReached: () => void active.loadMore(),
    onEndReachedThreshold: 0.4,
    ListFooterComponent: active.loadingMore ? <ActivityIndicator style={styles.footer} color={colors.text} /> : null,
    ListEmptyComponent: active.loading ? null : (
      <EmptyState icon={<EmptyIcon size={32} color={colors.mutedForeground} />} title={emptyTitle} description={emptyText} />
    ),
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <TabHeader
        title={isPeople ? t.contacts.people : t.contacts.companies}
        right={
          <IconButton
            icon={<Plus size={22} color={colors.text} />}
            accessibilityLabel={isPeople ? t.contacts.addPerson : t.contacts.addCompany}
            onPress={() => router.push(isPeople ? '/person/new' : '/company/new')}
          />
        }
      >
        <SearchBar
          value={search}
          onChangeText={setSearch}
          placeholder={isPeople ? t.contacts.searchPeople : t.contacts.searchCompanies}
          containerStyle={styles.search}
        />
        <View style={styles.chips}>
          {(['all', 'leads', 'suppliers'] as const).map((key) => (
            <Chip key={key} label={t.contacts.filters[key]} selected={filter === key} onPress={() => setFilter(key)} />
          ))}
        </View>
      </TabHeader>

      {active.loading && <ActivityIndicator style={styles.loading} size="large" color={colors.text} />}

      {!active.loading && isPeople && (
        <FlatList
          {...listProps}
          data={people.items}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <RecordRow
              testID="person-row"
              leading={<InitialsTile name={item.name} round />}
              title={item.name}
              subtitle={[item.jobTitle, ...flagsOf(item)].filter(Boolean).join(' · ') || undefined}
              meta={item.email || item.phone || item.mobile}
              badge={badgeFor(item.status)}
              onPress={() => openRecord(item.id, item.name)}
              onLongPress={() => setActionTarget(targetOf('people', item))}
            />
          )}
        />
      )}

      {!active.loading && !isPeople && (
        <FlatList
          {...listProps}
          data={companies.items}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <RecordRow
              testID="company-row"
              leading={<InitialsTile name={item.name} />}
              title={item.name}
              subtitle={[item.industry, ...flagsOf(item)].filter(Boolean).join(' · ') || undefined}
              meta={item.email || item.phone || item.website}
              badge={badgeFor(item.status)}
              onPress={() => openRecord(item.id, item.name)}
              onLongPress={() => setActionTarget(targetOf('companies', item))}
            />
          )}
        />
      )}

      <OptionSheet<RowAction>
        visible={!!actionTarget}
        title={actionTarget?.name ?? ''}
        options={actionOptions}
        onSelect={runAction}
        onClose={() => setActionTarget(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  search: { borderRadius: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  loading: { marginTop: 48 },
  footer: { paddingVertical: 16 },
  emptyContainer: { flexGrow: 1 },
});
