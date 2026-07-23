import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Search, FolderKanban } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useProjects } from '@/hooks/use-weldflow';
import { ProjectCard } from '@/components/ProjectCard';
import { EmptyState } from '@/components/EmptyState';

const STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'Planning', label: 'Planning' },
  { id: 'Active', label: 'Active' },
  { id: 'OnHold', label: 'On Hold' },
  { id: 'Completed', label: 'Completed' },
];

export default function ProjectsScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const params = useMemo(
    () => ({
      limit: 25,
      search: search.trim() || undefined,
      status: statusFilter === 'all' ? undefined : statusFilter,
    }),
    [search, statusFilter],
  );

  const { data, isLoading, isRefetching, refetch } = useProjects(params);
  const projects = data?.data ?? [];

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Projects</Text>
      </View>

      <View style={[styles.searchRow, { backgroundColor: colors.cardBackground, borderColor: colors.divider }]}>
        <Search size={18} color={colors.muted} />
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder="Search projects"
          placeholderTextColor={colors.muted}
          value={search}
          onChangeText={setSearch}
          returnKeyType="search"
        />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterScroll}
        contentContainerStyle={styles.filterRow}
      >
        {STATUS_FILTERS.map((f) => {
          const active = statusFilter === f.id;
          return (
            <TouchableOpacity
              key={f.id}
              onPress={() => setStatusFilter(f.id)}
              style={[
                styles.filterChip,
                {
                  backgroundColor: active ? '#6366F1' : colors.cardBackground,
                  borderColor: active ? '#6366F1' : colors.divider,
                },
              ]}
            >
              <Text style={[styles.filterLabel, { color: active ? '#fff' : colors.text }]}>{f.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {isLoading ? (
        <ActivityIndicator style={{ marginTop: 32 }} size="large" color="#6366F1" />
      ) : (
        <FlatList
          data={projects}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <ProjectCard project={item} />}
          contentContainerStyle={[
            styles.listContent,
            projects.length === 0 && { flex: 1 },
          ]}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor="#6366F1" />}
          ListEmptyComponent={
            <EmptyState
              icon={<FolderKanban size={48} color={colors.muted} />}
              title="No projects yet"
              description="Projects you're part of will appear here."
            />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  headerTitle: { fontSize: 34, fontWeight: '700' },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginVertical: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 0.5,
  },
  searchInput: { flex: 1, fontSize: 15, padding: 0 },
  filterScroll: { flexGrow: 0, flexShrink: 0 },
  filterRow: { paddingHorizontal: 16, gap: 8, paddingVertical: 8, alignItems: 'center' },
  filterChip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 0.5 },
  filterLabel: { fontSize: 13, fontWeight: '600' },
  listContent: { padding: 16, paddingTop: 8 },
});
