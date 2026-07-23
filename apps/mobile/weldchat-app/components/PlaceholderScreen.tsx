import { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { ChevronLeft } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import type { ColorScheme } from '@/constants/colors';

interface PlaceholderScreenProps {
  title: string;
  icon: LucideIcon;
  heading: string;
  message: string;
}

export function PlaceholderScreen({ title, icon: Icon, heading, message }: PlaceholderScreenProps) {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors, insets.top), [colors, insets.top]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <ChevronLeft size={26} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{title}</Text>
        <View style={styles.backBtn} />
      </View>
      <View style={styles.body}>
        <View style={styles.iconWrap}>
          <Icon size={36} color={colors.textMuted} strokeWidth={1.5} />
        </View>
        <Text style={styles.heading}>{heading}</Text>
        <Text style={styles.message}>{message}</Text>
      </View>
    </View>
  );
}

const makeStyles = (c: ColorScheme, topInset: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bgPrimary },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingTop: topInset + 12,
      paddingHorizontal: 12,
      paddingBottom: 12,
      backgroundColor: c.bgPrimary,
      borderBottomWidth: 1,
      borderBottomColor: c.bgTertiary,
    },
    backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
    headerTitle: {
      flex: 1,
      fontSize: 17,
      fontWeight: '700',
      color: c.textPrimary,
      textAlign: 'center',
    },
    body: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
      gap: 12,
    },
    iconWrap: {
      width: 72,
      height: 72,
      borderRadius: 16,
      backgroundColor: c.bgSecondary,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 8,
    },
    heading: {
      fontSize: 18,
      fontWeight: '700',
      color: c.textPrimary,
      textAlign: 'center',
    },
    message: {
      fontSize: 14,
      color: c.textMuted,
      textAlign: 'center',
      lineHeight: 20,
    },
  });
