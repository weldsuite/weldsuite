import { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Phone, Video, PhoneCall } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import type { ColorScheme } from '@/constants/colors';
import { useCall } from '@/contexts/CallContext';
import appApi from '@/services/app-api';

interface ActiveCall {
  channelId: string;
  callId: string;
  callType: 'voice' | 'video';
  status: string;
  participantCount: number;
}

export default function CallsScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = makeStyles(colors);
  const { joinCall } = useCall();

  const [calls, setCalls] = useState<ActiveCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await appApi.chatCalls.active();
      setCalls((res.data ?? []) as ActiveCall[]);
    } catch (err) {
      console.error('[WeldChat] Failed to load active calls:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load();
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  const handleJoin = useCallback(
    async (callId: string) => {
      setJoiningId(callId);
      try {
        await joinCall(callId);
      } catch (err) {
        console.error('[WeldChat] Failed to join call:', err);
      } finally {
        setJoiningId(null);
      }
    },
    [joinCall],
  );

  const renderItem = ({ item }: { item: ActiveCall }) => {
    const isVideo = item.callType === 'video';
    return (
      <View style={styles.row}>
        <View style={styles.iconWrap}>
          {isVideo ? (
            <Video size={22} color={colors.success} strokeWidth={2} />
          ) : (
            <Phone size={22} color={colors.success} strokeWidth={2} />
          )}
        </View>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            Ongoing {isVideo ? 'video' : 'voice'} call
          </Text>
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {item.participantCount} {item.participantCount === 1 ? 'participant' : 'participants'}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.joinBtn}
          activeOpacity={0.85}
          onPress={() => handleJoin(item.callId)}
          disabled={joiningId === item.callId}
        >
          {joiningId === item.callId ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.joinBtnText}>Join</Text>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.headerRow}>
        <Text style={styles.headerTitle}>Calls</Text>
      </View>

      {loading && calls.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      ) : (
        <FlatList
          data={calls}
          keyExtractor={(item) => item.callId}
          renderItem={renderItem}
          contentContainerStyle={calls.length === 0 && styles.emptyContainer}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textMuted} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <PhoneCall size={30} color={colors.textMuted} strokeWidth={1.8} />
              </View>
              <Text style={styles.emptyTitle}>No active calls</Text>
              <Text style={styles.emptyText}>
                Voice and video calls happening in your conversations will appear here.
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

function makeStyles(c: ColorScheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bgPrimary },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    headerTitle: { fontSize: 26, fontWeight: '700', color: c.textPrimary },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      gap: 12,
    },
    iconWrap: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: c.bgSecondary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowText: { flex: 1 },
    rowTitle: { fontSize: 15, fontWeight: '600', color: c.textPrimary },
    rowSubtitle: { fontSize: 13, color: c.textSecondary, marginTop: 2 },
    joinBtn: {
      backgroundColor: c.success,
      borderRadius: 999,
      paddingHorizontal: 20,
      paddingVertical: 8,
      minWidth: 64,
      alignItems: 'center',
      justifyContent: 'center',
    },
    joinBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
    emptyContainer: { flexGrow: 1 },
    empty: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 40,
      paddingTop: 100,
    },
    emptyIcon: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: c.bgSecondary,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 16,
    },
    emptyTitle: { fontSize: 17, fontWeight: '600', color: c.textPrimary, marginBottom: 6 },
    emptyText: { fontSize: 14, color: c.textMuted, textAlign: 'center', lineHeight: 20 },
  });
}
