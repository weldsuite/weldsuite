import { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useUser } from '@clerk/expo';
import { Mail, User, Phone, Shield } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Card } from '@weldsuite/mobile-ui/components/Card';
import { Screen, ScreenHeader, SectionLabel } from '@/components/screen';
import { BRAND } from '@/lib/brand';
import type { ThemeColors } from '@/lib/theme-colors';

export default function ProfileScreen() {
  const { user } = useUser();
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const fullName = user?.fullName || user?.firstName || 'User';
  const email = user?.emailAddresses[0]?.emailAddress || '';
  const phone = user?.phoneNumbers?.[0]?.phoneNumber || '';

  return (
    <Screen header={<ScreenHeader title="Profile" onBack={() => router.back()} />}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.avatarSection}>
          <View style={styles.avatarWrapper}>
            {user?.imageUrl ? (
              <Image source={{ uri: user.imageUrl }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarFallback]}>
                <Text style={styles.avatarText}>{fullName[0].toUpperCase()}</Text>
              </View>
            )}
          </View>
          <Text style={styles.displayName}>{fullName}</Text>
          {user?.username ? <Text style={styles.username}>@{user.username}</Text> : null}
        </View>

        <SectionLabel>Personal Info</SectionLabel>
        <Card style={styles.card}>
          <View style={[styles.menuItem, { borderBottomColor: colors.border }]}>
            <User size={20} color={colors.text} />
            <View style={styles.menuItemContent}>
              <Text style={styles.menuItemLabel}>Name</Text>
              <Text style={styles.menuItemValue}>{fullName}</Text>
            </View>
          </View>
          <View style={[styles.menuItem, phone ? { borderBottomColor: colors.border } : { borderBottomWidth: 0 }]}>
            <Mail size={20} color={colors.text} />
            <View style={styles.menuItemContent}>
              <Text style={styles.menuItemLabel}>Email</Text>
              <Text style={styles.menuItemValue}>{email}</Text>
            </View>
          </View>
          {phone ? (
            <View style={[styles.menuItem, { borderBottomWidth: 0 }]}>
              <Phone size={20} color={colors.text} />
              <View style={styles.menuItemContent}>
                <Text style={styles.menuItemLabel}>Phone</Text>
                <Text style={styles.menuItemValue}>{phone}</Text>
              </View>
            </View>
          ) : null}
        </Card>

        <SectionLabel>Security</SectionLabel>
        <Card style={styles.card}>
          <View style={[styles.menuItem, { borderBottomWidth: 0 }]}>
            <Shield size={20} color={colors.text} />
            <View style={styles.menuItemContent}>
              <Text style={styles.menuItemValue}>Manage account settings on the web</Text>
            </View>
          </View>
        </Card>
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    scroll: { flex: 1 },
    scrollContent: { paddingBottom: 40 },
    avatarSection: { alignItems: 'center', paddingVertical: 20 },
    avatarWrapper: { position: 'relative', marginBottom: 12 },
    avatar: { width: 80, height: 80, borderRadius: 20 },
    avatarFallback: {
      backgroundColor: BRAND,
      justifyContent: 'center',
      alignItems: 'center',
    },
    avatarText: { fontSize: 32, fontWeight: '700', color: '#fff' },
    displayName: { fontSize: 22, fontWeight: '700', color: c.text },
    username: { fontSize: 15, color: c.muted, marginTop: 2 },
    card: { marginHorizontal: 16, borderRadius: 16, overflow: 'hidden', paddingVertical: 0 },
    menuItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 14,
      paddingHorizontal: 16,
      gap: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    menuItemContent: { flex: 1 },
    menuItemLabel: { fontSize: 12, color: c.muted, marginBottom: 1 },
    menuItemValue: { fontSize: 16, color: c.text },
  });
