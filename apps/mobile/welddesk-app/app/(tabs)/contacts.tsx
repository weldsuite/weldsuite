import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import api from '@/services/api';

export default function ContactsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const [contacts, setContacts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchContacts = useCallback(async () => {
    try {
      const response = await api.getContacts({ limit: 50 });
      if (response.success && response.data) {
        const items = response.data.items || response.data.data || response.data;
        setContacts(Array.isArray(items) ? items : []);
      }
    } catch (error) {
      console.error('Failed to fetch contacts:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchContacts(); }, [fetchContacts]);

  if (loading) {
    return <View style={[styles.center, { backgroundColor: colors.background }]}><ActivityIndicator size="large" color={colors.text} /></View>;
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Contacts</Text>
      </View>
      <FlatList
        data={contacts}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchContacts(); }} />}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.item, { borderBottomColor: colors.divider }]}
            onPress={() => router.push(`/contact/${item.id}`)}
          >
            <Text style={[styles.itemName, { color: colors.text }]}>{item.name || item.email || 'Unknown'}</Text>
            {item.email && <Text style={[styles.itemEmail, { color: colors.muted }]}>{item.email}</Text>}
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: colors.muted }]}>No contacts</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { paddingHorizontal: 16, paddingTop: 60, paddingBottom: 16 },
  headerTitle: { fontSize: 34, fontWeight: '700' },
  item: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 0.5 },
  itemName: { fontSize: 16, fontWeight: '500' },
  itemEmail: { fontSize: 14, marginTop: 2 },
  empty: { padding: 32, alignItems: 'center' },
  emptyText: { fontSize: 16 },
});
