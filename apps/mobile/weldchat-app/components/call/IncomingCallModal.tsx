/**
 * Full-screen incoming-call overlay. Rendered globally (under CallProvider) so
 * a ring surfaces over whatever screen the user is on. Driven entirely by
 * CallContext: visible when `status === 'ringing-incoming'`.
 */

import React from 'react';
import { Modal, View, Text, Image, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Phone, PhoneOff, Video } from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useCall } from '@/contexts/CallContext';

export function IncomingCallModal() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { status, incomingCall, acceptIncomingCall, declineCall } = useCall();

  const visible = status === 'ringing-incoming' && !!incomingCall;
  const isVideo = incomingCall?.callType === 'video';
  const initial = (incomingCall?.callerName ?? '?').trim()[0]?.toUpperCase() ?? '?';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={declineCall}>
      <View style={[styles.backdrop, { backgroundColor: colors.bgTertiary }]}>
        <View style={[styles.top, { paddingTop: insets.top + 48 }]}>
          {incomingCall?.callerAvatar ? (
            <Image source={{ uri: incomingCall.callerAvatar }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: colors.brand }]}>
              <Text style={styles.avatarText}>{initial}</Text>
            </View>
          )}
          <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
            {incomingCall?.callerName}
          </Text>
          <View style={styles.subtitleRow}>
            {isVideo ? (
              <Video size={16} color={colors.textMuted} strokeWidth={2} />
            ) : (
              <Phone size={16} color={colors.textMuted} strokeWidth={2} />
            )}
            <Text style={[styles.subtitle, { color: colors.textMuted }]}>
              {isVideo ? 'Incoming video call' : 'Incoming voice call'}
            </Text>
          </View>
        </View>

        <View style={[styles.actions, { paddingBottom: insets.bottom + 56 }]}>
          <View style={styles.action}>
            <TouchableOpacity
              style={[styles.button, { backgroundColor: colors.danger }]}
              onPress={declineCall}
              activeOpacity={0.85}
              accessibilityLabel="Decline call"
            >
              <PhoneOff size={28} color="#fff" strokeWidth={2} />
            </TouchableOpacity>
            <Text style={[styles.actionLabel, { color: colors.textSecondary }]}>Decline</Text>
          </View>

          <View style={styles.action}>
            <TouchableOpacity
              style={[styles.button, { backgroundColor: colors.success }]}
              onPress={acceptIncomingCall}
              activeOpacity={0.85}
              accessibilityLabel="Accept call"
            >
              {isVideo ? (
                <Video size={28} color="#fff" strokeWidth={2} />
              ) : (
                <Phone size={28} color="#fff" strokeWidth={2} />
              )}
            </TouchableOpacity>
            <Text style={[styles.actionLabel, { color: colors.textSecondary }]}>Accept</Text>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'space-between' },
  top: { alignItems: 'center', paddingHorizontal: 32 },
  avatar: { width: 112, height: 112, borderRadius: 56 },
  avatarFallback: { justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#fff', fontSize: 44, fontWeight: '700' },
  name: { fontSize: 26, fontWeight: '700', marginTop: 24, textAlign: 'center' },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  subtitle: { fontSize: 15 },
  actions: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 48 },
  action: { alignItems: 'center', gap: 12 },
  button: {
    width: 72,
    height: 72,
    borderRadius: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionLabel: { fontSize: 14, fontWeight: '500' },
});
