import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronRight, UsersRound } from 'lucide-react-native';
import { Avatar } from '@weldsuite/mobile-ui/components/Avatar';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { SearchBar } from '@weldsuite/mobile-ui/components/SearchBar';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { ErrorNote, Panel, Screen } from '@/components/Screen';
import { useEmployees, useHrAccess } from '@/hooks/use-weldhr-queries';
import { useI18n } from '@/lib/i18n';

export default function DirectoryScreen() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const router = useRouter();
  const { access } = useHrAccess();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const employees = useEmployees(query, access.directory);

  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current);
  }, []);

  const onSearch = (text: string) => {
    setSearch(text);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setQuery(text.trim()), 300);
  };

  const rows = employees.data ?? [];

  return (
    <Screen
      title={t.directory.title}
      variant="push"
      refreshing={employees.isRefetching}
      onRefresh={() => void employees.refetch()}
    >
      <SearchBar
        value={search}
        onChangeText={onSearch}
        placeholder={t.directory.search}
        autoCorrect={false}
        autoCapitalize="none"
        onClear={() => {
          setSearch('');
          setQuery('');
        }}
      />
      {employees.isPending ? (
        <ActivityIndicator style={styles.loading} />
      ) : employees.isError ? (
        <ErrorNote message={t.common.somethingWrong} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<UsersRound size={36} color={colors.mutedForeground} />}
          title={t.directory.empty}
          description={t.directory.emptyDescription}
        />
      ) : (
        <Panel>
          {rows.map((employee, index) => (
            <Pressable
              key={employee.id}
              onPress={() => router.push({ pathname: '/employee/[id]', params: { id: employee.id } })}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.row,
                index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                pressed && { backgroundColor: colors.pressed },
              ]}
            >
              <Avatar name={employee.displayName} source={employee.avatarUrl ? { uri: employee.avatarUrl } : undefined} size={40} />
              <View style={styles.text}>
                <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
                  {employee.displayName}
                </Text>
                <Text style={[styles.sub, { color: colors.mutedForeground }]} numberOfLines={1}>
                  {[employee.jobTitle, employee.departmentName].filter(Boolean).join(' · ') || employee.email}
                </Text>
              </View>
              <ChevronRight size={18} color={colors.mutedForeground} />
            </Pressable>
          ))}
        </Panel>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 32 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10 },
  text: { flex: 1, gap: 2 },
  name: { fontSize: 15, fontWeight: '600' },
  sub: { fontSize: 13 },
});
