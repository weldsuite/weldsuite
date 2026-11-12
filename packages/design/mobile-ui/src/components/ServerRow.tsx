/**
 * Which server the app talks to, with a way to change it:
 * - `variant="login"`: one line under the sign-in form ("Server: WeldSuite cloud · Change").
 * - `variant="settings"`: a settings row ("Server  WeldSuite EU  ›"), with a
 *   note when the server can't send notifications.
 *
 * Renders nothing when the build has the server picker off
 * (`EXPO_PUBLIC_SERVER_PICKER`), so Global-only builds look as before.
 */

import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { peekMobileRuntime } from '@weldsuite/mobile-platform/runtime';
import { useHostedSignIn } from '@weldsuite/mobile-platform/auth';
import { ServerPicker, serverCopy, serverDisplayName } from './ServerPicker';
import { useTheme } from '../contexts/ThemeContext';
import { Spacing } from '../constants/theme';
import type { ServerCopy, ServerLanguage } from '../constants/server-copy';

export interface ServerRowProps {
  variant?: 'login' | 'settings';
  language?: ServerLanguage;
  copy?: Partial<ServerCopy>;
  accentColor?: string;
  /** Development builds may connect to http:// servers. @default __DEV__ */
  allowInsecure?: boolean;
}

export function ServerRow({
  variant = 'login',
  language = 'en',
  copy,
  accentColor = '#3B82F6',
  allowInsecure = __DEV__,
}: Readonly<ServerRowProps>) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const runtime = peekMobileRuntime();
  if (!runtime || !runtime.serverPickerEnabled) return null;
  const labels = serverCopy(language, copy);
  const name = serverDisplayName(runtime.server, labels);

  const picker = (
    <ServerPicker
      visible={open}
      onClose={() => setOpen(false)}
      app={runtime.app}
      current={runtime.server}
      euOrigin={runtime.euOrigin}
      language={language}
      copy={copy}
      accentColor={accentColor}
      confirm={variant === 'settings'}
      allowInsecure={allowInsecure}
    />
  );

  if (variant === 'login') {
    return (
      <View style={styles.loginRow}>
        <Pressable
          testID="server-row"
          accessibilityRole="button"
          accessibilityLabel={`${labels.serverLabel}: ${name}. ${labels.change}`}
          onPress={() => setOpen(true)}
          hitSlop={8}
        >
          <Text style={[styles.loginText, { color: colors.mutedForeground }]}>
            {`${labels.serverLabel}: `}
            <Text style={{ color: colors.text, fontWeight: '600' }}>{name}</Text>
            {'  ·  '}
            <Text style={{ color: accentColor, fontWeight: '600' }}>{labels.change}</Text>
          </Text>
        </Pressable>
        {picker}
      </View>
    );
  }

  return (
    <View>
      <Pressable
        testID="server-settings-row"
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.settingsRow, pressed && { backgroundColor: colors.pressed }]}
      >
        <Text style={[styles.settingsLabel, { color: colors.text }]}>{labels.settingsSwitch}</Text>
        <View style={styles.settingsValue}>
          <Text style={[styles.settingsValueText, { color: colors.mutedForeground }]} numberOfLines={1}>
            {name}
          </Text>
          <ChevronRight size={18} color={colors.mutedForeground} />
        </View>
      </Pressable>
      {runtime.pushEnabled ? null : (
        <Text style={[styles.note, { color: colors.mutedForeground }]}>{labels.pushOff}</Text>
      )}
      {picker}
    </View>
  );
}

/**
 * Whether the settings screen has anything to show about the server: the
 * picker (when the build has it on) or the provider's account page (OIDC).
 * False on production Global builds, so their settings look as before.
 */
export function useServerSettingsVisible(): boolean {
  const hosted = useHostedSignIn();
  return Boolean(peekMobileRuntime()?.serverPickerEnabled || hosted?.accountUrl);
}

/**
 * The settings card with `ServerRow` and `ProviderAccountRow`, rendered only
 * when one of them has something to show (no empty card on production Global).
 */
export function ServerSettingsSection({
  style,
  ...row
}: Readonly<Omit<ServerRowProps, 'variant'> & { style?: StyleProp<ViewStyle> }>) {
  const visible = useServerSettingsVisible();
  if (!visible) return null;
  return (
    <View style={style}>
      <ServerRow variant="settings" {...row} />
      <ProviderAccountRow language={row.language} copy={row.copy} />
    </View>
  );
}

/**
 * "Manage your account" on servers where the identity provider, not
 * WeldSuite, holds the account (OIDC). Null on Clerk.
 */
export function ProviderAccountRow({
  language = 'en',
  copy,
}: Readonly<{ language?: ServerLanguage; copy?: Partial<ServerCopy> }>) {
  const { colors } = useTheme();
  const hosted = useHostedSignIn();
  const url = hosted?.accountUrl;
  if (!url) return null;
  const labels = serverCopy(language, copy);
  return (
    <Pressable
      testID="provider-account-row"
      accessibilityRole="link"
      onPress={() => void Linking.openURL(url)}
      style={({ pressed }) => [styles.settingsRow, pressed && { backgroundColor: colors.pressed }]}
    >
      <Text style={[styles.settingsLabel, { color: colors.text }]}>{labels.accountAtServer}</Text>
      <ChevronRight size={18} color={colors.mutedForeground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  loginRow: {
    marginTop: Spacing.xl,
    alignItems: 'center',
  },
  loginText: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    minHeight: 48,
  },
  settingsLabel: {
    fontSize: 16,
  },
  settingsValue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    flexShrink: 1,
    marginLeft: Spacing.md,
  },
  settingsValueText: {
    fontSize: 15,
    flexShrink: 1,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
});
