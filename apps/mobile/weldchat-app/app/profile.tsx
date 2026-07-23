import { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { Image } from 'expo-image';
import { Stack, useRouter } from 'expo-router';
import { useUser } from '@clerk/expo';
import { ChevronLeft, Mail, User, Phone, Shield } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import type { ColorScheme } from '@/constants/colors';

export default function ProfileScreen() {
  const { user } = useUser();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors, insets.top, insets.bottom), [colors, insets.top, insets.bottom]);

  const fullName = user?.fullName || user?.firstName || 'User';
  const email = user?.emailAddresses[0]?.emailAddress || '';
  const phone = user?.phoneNumbers?.[0]?.phoneNumber || '';

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <ChevronLeft size={24} color={colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Profile</Text>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {/* Avatar */}
          <View style={styles.avatarSection}>
            <View style={styles.avatarWrapper}>
              {user?.imageUrl ? (
                <Image source={{ uri: user.imageUrl }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarFallback]}>
                  <Text style={styles.avatarText}>
                    {fullName[0].toUpperCase()}
                  </Text>
                </View>
              )}
            </View>
            <Text style={styles.displayName}>{fullName}</Text>
            {user?.username && (
              <Text style={styles.username}>@{user.username}</Text>
            )}
          </View>

          {/* Info */}
          <Text style={styles.sectionLabel}>Personal Info</Text>
          <View style={styles.card}>
            <View style={styles.menuItem}>
              <User size={20} color={colors.textPrimary} />
              <View style={styles.menuItemContent}>
                <Text style={styles.menuItemLabel}>Name</Text>
                <Text style={styles.menuItemValue}>{fullName}</Text>
              </View>
            </View>
            <View style={styles.menuDivider} />
            <View style={styles.menuItem}>
              <Mail size={20} color={colors.textPrimary} />
              <View style={styles.menuItemContent}>
                <Text style={styles.menuItemLabel}>Email</Text>
                <Text style={styles.menuItemValue}>{email}</Text>
              </View>
            </View>
            {phone ? (
              <>
                <View style={styles.menuDivider} />
                <View style={styles.menuItem}>
                  <Phone size={20} color={colors.textPrimary} />
                  <View style={styles.menuItemContent}>
                    <Text style={styles.menuItemLabel}>Phone</Text>
                    <Text style={styles.menuItemValue}>{phone}</Text>
                  </View>
                </View>
              </>
            ) : null}
          </View>

          {/* Security */}
          <Text style={styles.sectionLabel}>Security</Text>
          <View style={styles.card}>
            <View style={styles.menuItem}>
              <Shield size={20} color={colors.textPrimary} />
              <View style={styles.menuItemContent}>
                <Text style={styles.menuItemValue}>Manage account settings on the web</Text>
              </View>
            </View>
          </View>
        </ScrollView>
      </View>
    </>
  );
}

const makeStyles = (c: ColorScheme, topInset: number, bottomInset: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bgPrimary },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingTop: topInset + 12,
      paddingHorizontal: 16,
      paddingBottom: 12,
      backgroundColor: c.bgPrimary,
      borderBottomWidth: 1,
      borderBottomColor: c.bgTertiary,
      gap: 8,
    },
    backBtn: { padding: 4 },
    headerTitle: { fontSize: 18, fontWeight: '700', color: c.textPrimary },
    scroll: { flex: 1 },
    scrollContent: { padding: 16, paddingBottom: 16 + bottomInset },
    avatarSection: { alignItems: 'center', paddingVertical: 20 },
    avatarWrapper: { position: 'relative', marginBottom: 12 },
    avatar: { width: 80, height: 80, borderRadius: 20 },
    avatarFallback: {
      backgroundColor: c.brand,
      justifyContent: 'center',
      alignItems: 'center',
    },
    avatarText: { fontSize: 32, fontWeight: '700', color: '#fff' },
    displayName: { fontSize: 22, fontWeight: '700', color: c.textPrimary },
    username: { fontSize: 15, color: c.textMuted, marginTop: 2 },
    sectionLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 8,
      marginLeft: 4,
    },
    card: {
      backgroundColor: c.bgPrimary,
      borderRadius: 12,
      marginBottom: 24,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: c.bgTertiary,
    },
    menuItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 14,
      paddingHorizontal: 16,
      gap: 14,
    },
    menuItemContent: { flex: 1 },
    menuItemLabel: { fontSize: 12, color: c.textMuted, marginBottom: 1 },
    menuItemValue: { fontSize: 16, color: c.textPrimary },
    menuDivider: { height: 1, backgroundColor: c.bgTertiary, marginLeft: 50 },
  });
