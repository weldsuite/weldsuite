import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Modal,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Archive, Edit3, Mail, MoreHorizontal, Phone, Plus, Trash2, X } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { SegmentedControl } from '@weldsuite/mobile-ui/components/SegmentedControl';
import { TabHeader } from '@/components/headers';
import { usePagedList } from '@/hooks/use-paged-list';
import { api, type CompanyRecord, type PersonRecord } from '@/services/api';
import { interpolate, labelFor, useI18n, type Translations } from '@/lib/i18n';
import { initialsOf } from '@/lib/crm';

type Segment = 'people' | 'companies';
/** The web's People/Companies `filter`: a lead or a supplier is a flag on the record. */
type Filter = 'all' | 'leads' | 'suppliers';

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
};

const statusColor = (status?: string) => STATUS_COLORS[status?.toLowerCase() ?? ''] ?? '#6B7280';

interface RecordCardProps {
  title: string;
  subtitle?: string;
  email?: string;
  phone?: string;
  status?: string;
  /** Small labels next to the name: Lead, Supplier, Archived. */
  flags: string[];
  icon?: 'company';
  onPress: () => void;
  onMore: () => void;
  t: Translations;
}

function RecordCard({
  title,
  subtitle,
  email,
  phone,
  status,
  flags,
  icon,
  onPress,
  onMore,
  t,
}: Readonly<RecordCardProps>) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: colors.background, borderColor: colors.divider }]}
      activeOpacity={0.7}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      <View style={styles.cardHeader}>
        <View style={[styles.avatar, icon === 'company' && styles.avatarSquare]}>
          <Text style={styles.avatarText}>{initialsOf(title)}</Text>
        </View>
        <View style={styles.cardMain}>
          <Text style={[styles.cardTitle, { color: colors.text }]} numberOfLines={1}>
            {title}
          </Text>
          {!!subtitle && (
            <View style={styles.subtitleRow}>
              <Text style={[styles.cardSubtitle, { color: colors.muted }]} numberOfLines={1}>
                {subtitle}
              </Text>
            </View>
          )}
        </View>
        {!!status && (
          <View style={[styles.statusBadge, { backgroundColor: `${statusColor(status)}20` }]}>
            <Text style={[styles.statusText, { color: statusColor(status) }]}>{labelFor(t.status, status)}</Text>
          </View>
        )}
        <TouchableOpacity
          onPress={onMore}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel={interpolate(t.contacts.actionsFor, { name: title })}
        >
          <MoreHorizontal size={18} color={colors.muted} />
        </TouchableOpacity>
      </View>

      {flags.length > 0 && (
        <View style={styles.flags}>
          {flags.map((flag) => (
            <View key={flag} style={[styles.flag, { backgroundColor: colors.secondary }]}>
              <Text style={[styles.flagText, { color: colors.text }]}>{flag}</Text>
            </View>
          ))}
        </View>
      )}

      {(!!email || !!phone) && (
        <View style={styles.details}>
          {!!email && (
            <View style={styles.detailRow}>
              <Mail size={14} color={colors.muted} />
              <Text style={[styles.detailText, { color: colors.text }]} numberOfLines={1}>
                {email}
              </Text>
            </View>
          )}
          {!!phone && (
            <View style={styles.detailRow}>
              <Phone size={14} color={colors.muted} />
              <Text style={[styles.detailText, { color: colors.text }]} numberOfLines={1}>
                {phone}
              </Text>
            </View>
          )}
        </View>
      )}

    </TouchableOpacity>
  );
}

export default function ContactsScreen() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const [segment, setSegment] = useState<Segment>('people');
  const [filter, setFilter] = useState<Filter>('all');
  const params = useLocalSearchParams<{ segment?: string; filter?: string }>();

  // Home's figures land here with ?segment= / ?filter=.
  useEffect(() => {
    if (!params.segment && !params.filter) return;
    if (params.segment === 'people' || params.segment === 'companies') setSegment(params.segment);
    if (params.filter === 'all' || params.filter === 'leads' || params.filter === 'suppliers') setFilter(params.filter);
    router.setParams({ segment: undefined, filter: undefined });
  }, [params.segment, params.filter]);
  const [search, setSearch] = useState('');
  const [actionTarget, setActionTarget] = useState<ActionTarget | null>(null);

  const fetchPeople = useCallback(
    (params: { cursor: string | null; search: string }) =>
      api.getPeople({ ...params, isLead: filter === 'leads', isSupplier: filter === 'suppliers' }),
    [filter],
  );
  const fetchCompanies = useCallback(
    (params: { cursor: string | null; search: string }) =>
      api.getCompanies({ ...params, isLead: filter === 'leads', isSupplier: filter === 'suppliers' }),
    [filter],
  );

  const people = usePagedList<PersonRecord>(fetchPeople, { search, enabled: segment === 'people', resetKey: filter });
  const companies = usePagedList<CompanyRecord>(fetchCompanies, { search, enabled: segment === 'companies', resetKey: filter });
  const active = segment === 'people' ? people : companies;

  // The search box is shared: switching between People and Companies starts a fresh search.
  useEffect(() => {
    setSearch('');
  }, [segment]);

  useEffect(() => {
    if (active.error) toast.error(t.contacts.loadFailed);
  }, [active.error, t, toast]);

  const openRecord = (kind: Segment, id: string, name: string, edit?: boolean) => {
    router.push({
      pathname: kind === 'people' ? '/person/[id]' : '/company/[id]',
      params: { id, name, ...(edit ? { edit: 'true' } : {}) },
    });
  };

  const handleAdd = () => router.push(segment === 'people' ? '/person/new' : '/company/new');

  const closeActions = () => setActionTarget(null);

  const handleCall = () => {
    if (actionTarget?.phone) {
      void Linking.openURL(`tel:${actionTarget.phone}`);
    } else {
      toast.error(t.common.noPhone);
    }
    closeActions();
  };

  const handleEmail = () => {
    if (actionTarget?.email) void Linking.openURL(`mailto:${actionTarget.email}`);
    closeActions();
  };

  const handleEdit = () => {
    if (actionTarget) openRecord(actionTarget.kind, actionTarget.id, actionTarget.name, true);
    closeActions();
  };

  const handleArchive = async () => {
    const target = actionTarget;
    closeActions();
    if (!target) return;
    const archive = !target.archived;
    if (target.kind === 'people') {
      const res = await api.setPersonArchived(target.id, archive);
      if (res.success && res.data) people.updateItem(res.data);
      else return toast.error(t.records.archiveFailed);
    } else {
      const res = await api.setCompanyArchived(target.id, archive);
      if (res.success && res.data) companies.updateItem(res.data);
      else return toast.error(t.records.archiveFailed);
    }
    toast.success(archive ? t.records.archivedToast : t.records.unarchivedToast);
  };

  const flagsOf = (record: { isLead: boolean; isSupplier: boolean; archivedAt?: string }) =>
    [
      record.isLead ? t.records.isLead : '',
      record.isSupplier ? t.records.isSupplier : '',
      record.archivedAt ? t.records.archived : '',
    ].filter(Boolean);

  const handleDelete = () => {
    const target = actionTarget;
    closeActions();
    if (!target) return;
    const copy = target.kind === 'people' ? t.person : t.company;
    Alert.alert(copy.deleteTitle, interpolate(copy.deleteMessage, { name: target.name }), [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.common.delete,
        style: 'destructive',
        onPress: () => {
          void (async () => {
            const res = target.kind === 'people' ? await api.deletePerson(target.id) : await api.deleteCompany(target.id);
            if (res.success) {
              (target.kind === 'people' ? people : companies).removeItem(target.id);
              toast.success(copy.deletedToast);
            } else {
              toast.error(typeof res.error === 'string' ? res.error : t.contacts.deleteFailed);
            }
          })();
        },
      },
    ]);
  };

  const renderEmpty = () => {
    if (active.loading) return null;
    return (
      <View style={styles.emptyState}>
        {active.error ? (
          <>
            <Text style={[styles.emptyTitle, { color: colors.text }]}>{t.contacts.loadFailed}</Text>
            <Text style={[styles.emptyText, { color: colors.muted }]}>{t.common.pullToRetry}</Text>
          </>
        ) : (
          <>
            <Text style={[styles.emptyTitle, { color: colors.text }]}>
              {segment === 'people' ? t.contacts.emptyPeople : t.contacts.emptyCompanies}
            </Text>
            {!search && (
              <Text style={[styles.emptyText, { color: colors.muted }]}>
                {segment === 'people' ? t.contacts.emptyPeopleHint : t.contacts.emptyCompaniesHint}
              </Text>
            )}
          </>
        )}
      </View>
    );
  };

  const refreshControl = <RefreshControl refreshing={active.refreshing} onRefresh={() => void active.refresh()} />;
  const footer = active.loadingMore ? <ActivityIndicator style={styles.footerSpinner} color={colors.text} /> : null;
  const showPeople = !active.loading && segment === 'people';
  const showCompanies = !active.loading && segment === 'companies';

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <TabHeader
        title={t.contacts.title}
        right={
          <TouchableOpacity
            style={[styles.addButton, { borderColor: colors.buttonBorder }]}
            onPress={handleAdd}
            accessibilityRole="button"
            accessibilityLabel={segment === 'people' ? t.contacts.addPerson : t.contacts.addCompany}
          >
            <Plus size={18} color={colors.text} strokeWidth={2} />
          </TouchableOpacity>
        }
      >
        <SegmentedControl
          options={[
            { value: 'people', label: t.contacts.people },
            { value: 'companies', label: t.contacts.companies },
          ]}
          value={segment}
          onValueChange={(value) => setSegment(value as Segment)}
          style={styles.segments}
        />
      </TabHeader>

      <View style={[styles.searchBar, { backgroundColor: colors.inputBackground }]}>
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder={segment === 'people' ? t.contacts.searchPeople : t.contacts.searchCompanies}
          placeholderTextColor={colors.muted}
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
      </View>

      <View style={styles.filters}>
        {(['all', 'leads', 'suppliers'] as const).map((key) => {
          const selected = filter === key;
          return (
            <TouchableOpacity
              key={key}
              style={[
                styles.filterChip,
                {
                  backgroundColor: selected ? colors.text : colors.background,
                  borderColor: selected ? colors.text : colors.buttonBorder,
                },
              ]}
              onPress={() => setFilter(key)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
            >
              <Text style={[styles.filterText, { color: selected ? colors.background : colors.text }]}>
                {t.contacts.filters[key]}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {active.loading && (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.text} />
        </View>
      )}

      {showPeople && (
        <FlatList
          data={people.items}
          keyExtractor={(item) => item.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
          refreshControl={refreshControl}
          onEndReached={() => void people.loadMore()}
          onEndReachedThreshold={0.4}
          ListEmptyComponent={renderEmpty}
          ListFooterComponent={footer}
          renderItem={({ item }) => (
            <RecordCard
              title={item.name}
              subtitle={item.jobTitle}
              email={item.email}
              phone={item.phone ?? item.mobile}
              status={item.status}
              flags={flagsOf(item)}
              onPress={() => openRecord('people', item.id, item.name)}
              onMore={() =>
                setActionTarget({
                  kind: 'people',
                  id: item.id,
                  name: item.name,
                  email: item.email,
                  phone: item.phone ?? item.mobile,
                  archived: !!item.archivedAt,
                })
              }
              t={t}
            />
          )}
        />
      )}

      {showCompanies && (
        <FlatList
          data={companies.items}
          keyExtractor={(item) => item.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
          refreshControl={refreshControl}
          onEndReached={() => void companies.loadMore()}
          onEndReachedThreshold={0.4}
          ListEmptyComponent={renderEmpty}
          ListFooterComponent={footer}
          renderItem={({ item }) => (
            <RecordCard
              icon="company"
              title={item.name}
              subtitle={item.industry}
              email={item.email}
              phone={item.phone}
              status={item.status}
              flags={flagsOf(item)}
              onPress={() => openRecord('companies', item.id, item.name)}
              onMore={() =>
                setActionTarget({
                  kind: 'companies',
                  id: item.id,
                  name: item.name,
                  email: item.email,
                  phone: item.phone ?? item.mobile,
                  archived: !!item.archivedAt,
                })
              }
              t={t}
            />
          )}
        />
      )}

      <Modal visible={!!actionTarget} animationType="fade" transparent onRequestClose={closeActions}>
        <TouchableOpacity style={styles.menuOverlay} activeOpacity={1} onPress={closeActions}>
          <View style={[styles.menuCard, { backgroundColor: colors.background }]}>
            <View style={[styles.menuHeader, { borderBottomColor: colors.divider }]}>
              <Text style={[styles.menuName, { color: colors.text }]} numberOfLines={1}>
                {actionTarget?.name}
              </Text>
              <TouchableOpacity onPress={closeActions} accessibilityRole="button" accessibilityLabel={t.common.close}>
                <X size={20} color={colors.muted} />
              </TouchableOpacity>
            </View>
            {!!actionTarget?.phone && (
              <TouchableOpacity style={styles.menuItem} onPress={handleCall}>
                <Phone size={20} color={colors.text} />
                <Text style={[styles.menuItemText, { color: colors.text }]}>{t.common.call}</Text>
              </TouchableOpacity>
            )}
            {!!actionTarget?.email && (
              <TouchableOpacity style={styles.menuItem} onPress={handleEmail}>
                <Mail size={20} color={colors.text} />
                <Text style={[styles.menuItemText, { color: colors.text }]}>{t.common.email}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.menuItem} onPress={handleEdit}>
              <Edit3 size={20} color={colors.text} />
              <Text style={[styles.menuItemText, { color: colors.text }]}>{t.common.edit}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={() => void handleArchive()}>
              <Archive size={20} color={colors.text} />
              <Text style={[styles.menuItemText, { color: colors.text }]}>
                {actionTarget?.archived ? t.records.unarchive : t.records.archive}
              </Text>
            </TouchableOpacity>
            <View style={[styles.menuDivider, { backgroundColor: colors.divider }]} />
            <TouchableOpacity style={styles.menuItem} onPress={handleDelete}>
              <Trash2 size={20} color={colors.destructive} />
              <Text style={[styles.menuItemText, { color: colors.destructive }]}>{t.common.delete}</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  addButton: { width: 36, height: 36, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  segments: { marginTop: 12 },
  searchBar: { marginHorizontal: 16, marginTop: 12, marginBottom: 4, borderRadius: 10 },
  searchInput: { paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  listContent: { padding: 16, paddingTop: 8, flexGrow: 1 },
  footerSpinner: { paddingVertical: 16 },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 48, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 16, fontWeight: '600', marginBottom: 6, textAlign: 'center' },
  emptyText: { fontSize: 13, textAlign: 'center' },
  card: { borderRadius: 12, borderWidth: 1, marginBottom: 12, overflow: 'hidden' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#E0E7FF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarSquare: { borderRadius: 10 },
  avatarText: { fontSize: 14, fontWeight: '600', color: '#4F46E5' },
  cardMain: { flex: 1 },
  cardTitle: { fontSize: 15, fontWeight: '600' },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  cardSubtitle: { fontSize: 13, flexShrink: 1 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  statusText: { fontSize: 11, fontWeight: '600' },
  details: { paddingHorizontal: 14, paddingBottom: 12, gap: 6 },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  detailText: { fontSize: 13, flexShrink: 1 },
  flags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 14, paddingBottom: 12, marginTop: -4 },
  flag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  flagText: { fontSize: 11, fontWeight: '600' },
  filters: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  filterChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  filterText: { fontSize: 13, fontWeight: '500' },
  menuOverlay: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.5)', justifyContent: 'flex-end' },
  menuCard: { borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 34 },
  menuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    gap: 12,
  },
  menuName: { flex: 1, fontSize: 16, fontWeight: '600' },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingVertical: 14 },
  menuItemText: { fontSize: 16 },
  menuDivider: { height: 1, marginVertical: 4, marginHorizontal: 20 },
});
