import React from 'react';
import { View, Text, StyleSheet, FlatList, RefreshControl, Pressable, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Plus, KeyRound, Video } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useUpcomingMeetings } from '@/hooks/useMeetings';
import { MeetingCard } from '@/components/MeetingCard';

export default function UpcomingScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data, loading, error, refresh } = useUpcomingMeetings();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={[styles.title, { color: colors.text }]}>Upcoming</Text>
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => router.push('/join')}
            style={({ pressed }) => [styles.iconBtn, { backgroundColor: colors.card, opacity: pressed ? 0.6 : 1 }]}
          >
            <KeyRound size={20} color={colors.text} />
          </Pressable>
          <Pressable
            onPress={() => router.push('/meeting/new')}
            style={({ pressed }) => [styles.iconBtn, { backgroundColor: '#7C3AED', opacity: pressed ? 0.7 : 1 }]}
          >
            <Plus size={20} color="#fff" />
          </Pressable>
        </View>
      </View>

      {loading && !data ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#7C3AED" />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={[styles.error, { color: colors.muted }]}>{error}</Text>
        </View>
      ) : (
        <FlatList
          data={data ?? []}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => (
            <MeetingCard meeting={item} onPress={() => router.push(`/meeting/${item.id}`)} />
          )}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor="#7C3AED" />}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Video size={48} color={colors.muted} />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>No upcoming meetings</Text>
              <Text style={[styles.emptyBody, { color: colors.muted }]}>
                Tap + to schedule a meeting, or join one with a code.
              </Text>
            </View>
          }
          contentContainerStyle={data?.length ? { paddingVertical: 8 } : styles.emptyContainer}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  title: { fontSize: 34, fontWeight: '700' },
  headerActions: { flexDirection: 'row', gap: 8 },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  error: { fontSize: 14 },
  emptyState: { alignItems: 'center', gap: 12, padding: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '600' },
  emptyBody: { fontSize: 14, textAlign: 'center' },
  emptyContainer: { flexGrow: 1, justifyContent: 'center' },
});
