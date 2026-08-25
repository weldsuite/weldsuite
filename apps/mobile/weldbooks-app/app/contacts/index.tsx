/**
 * Accounting contacts — the customers and suppliers invoices and bills are
 * issued against. Separate from WeldCRM contacts; app-api keeps its own
 * accounting contact table so a ledger entry never depends on CRM data.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, FlatList, RefreshControl, StyleSheet } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Users, Plus, Building2 } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { SearchBar } from '@weldsuite/mobile-ui/components/SearchBar';
import { Chip } from '@weldsuite/mobile-ui/components/Chip';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';

import api from '@/services/api';
import { ACCENTS } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { RecordRow } from '@/components/record-row';
import { IconTile } from '@/components/detail';
import { ListSkeleton, ErrorState } from '@/components/data-states';
import { useI18n } from '@/lib/i18n';
import type { Contact } from '@/types/accounting';

const FILTER_KEYS = [
  { key: 'all', value: undefined },
  { key: 'customer', value: 'customer' as const },
  { key: 'vendor', value: 'vendor' as const },
];

export default function ContactsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { t, format } = useI18n();

  const FILTERS = [
    { key: 'all', label: t.contacts.filterAll },
    { key: 'customer', label: t.contacts.filterCustomers },
    { key: 'vendor', label: t.contacts.filterSuppliers },
  ];

  const ROLE_LABELS: Record<string, string> = {
    customer: t.contacts.customer,
    supplier: t.contacts.supplier,
    both: t.contacts.both,
  };

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    try {
      setError(false);
      const type = FILTER_KEYS.find((f) => f.key === filter)?.value;
      setContacts(await api.getContacts({ search: debounced || undefined, type }));
    } catch (err) {
      console.error('Failed to load contacts:', err);
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [debounced, filter]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // A contact created on the `new` screen should appear on the way back.
  useFocusEffect(useCallback(() => void load(), [load]));

  const open = useCallback(
    (route: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      router.push(route as never);
    },
    [router],
  );

  const header = (
    <ScreenHeader
      title={t.contacts.title}
      subtitle={contacts.length ? format(t.contacts.shown, { count: contacts.length }) : undefined}
      showBack
      actions={
        <IconButton
          icon={<Plus size={22} color={colors.text} />}
          accessibilityLabel={t.contacts.newContact}
          onPress={() => open('/contacts/new')}
        />
      }
      below={
        <View style={styles.controls}>
          <SearchBar
            value={search}
            onChangeText={setSearch}
            placeholder={t.contacts.searchPlaceholder}
          />
          <View style={styles.chips}>
            {FILTERS.map((f) => (
              <Chip
                key={f.key}
                label={f.label}
                selected={filter === f.key}
                onPress={() => setFilter(f.key)}
              />
            ))}
          </View>
        </View>
      }
    />
  );

  if (loading) {
    return (
      <Screen header={header}>
        <ListSkeleton />
      </Screen>
    );
  }

  if (error && contacts.length === 0) {
    return (
      <Screen header={header}>
        <ErrorState message={t.contacts.loadError} onRetry={load} />
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <FlatList
        data={contacts}
        keyExtractor={(item) => item.id}
        contentContainerStyle={contacts.length ? styles.list : styles.listEmpty}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            tintColor={ACCENTS.contacts}
          />
        }
        renderItem={({ item }) => (
          <RecordRow
            leading={<IconTile icon={Building2} color={ACCENTS.contacts} />}
            title={item.name || t.contacts.unnamed}
            subtitle={item.email || undefined}
            meta={ROLE_LABELS[item.type] ?? item.type}
            onPress={() => open(`/contacts/${item.id}`)}
          />
        )}
        ListEmptyComponent={
          <EmptyState
            icon={<Users size={32} color={colors.mutedForeground} />}
            title={search ? t.contacts.noMatchTitle : t.contacts.emptyTitle}
            description={
              search ? t.contacts.noMatchDescription : t.contacts.emptyDescription
            }
            action={
              search ? undefined : (
                <Button title={t.contacts.newContact} onPress={() => open('/contacts/new')} />
              )
            }
          />
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  controls: { gap: 10, paddingBottom: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  list: { paddingBottom: 8 },
  listEmpty: { flexGrow: 1, justifyContent: 'center' },
});
