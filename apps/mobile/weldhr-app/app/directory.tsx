import { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { SearchBar } from '@weldsuite/mobile-ui/components/SearchBar';

import { EmptyState } from '@/components/EmptyState';
import { PersonAvatar } from '@/components/PersonAvatar';
import { QueryBody } from '@/components/QueryBody';
import { List, Row } from '@/components/Row';
import { Inset, Screen } from '@/components/Screen';
import { useEmployees, useHrAccess } from '@/hooks/use-weldhr-queries';
import { useI18n } from '@/lib/i18n';

export default function DirectoryScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const { access } = useHrAccess();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const employees = useEmployees(query, access.directory);

  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current);
    },
    [],
  );

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
      <Inset style={styles.search}>
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
      </Inset>
      <QueryBody query={employees}>
        {() =>
          rows.length === 0 ? (
            <EmptyState illustration="people" title={t.directory.empty} description={t.directory.emptyDescription} />
          ) : (
            <List>
              {rows.map((employee) => (
                <Row
                  key={employee.id}
                  leading={<PersonAvatar name={employee.displayName} url={employee.avatarUrl} />}
                  title={employee.displayName}
                  subtitle={[employee.jobTitle, employee.departmentName].filter(Boolean).join(' • ') || employee.email}
                  onPress={() => router.push({ pathname: '/employee/[id]', params: { id: employee.id } })}
                  chevron
                />
              ))}
            </List>
          )
        }
      </QueryBody>
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: { marginTop: 6, marginBottom: 6 },
});
