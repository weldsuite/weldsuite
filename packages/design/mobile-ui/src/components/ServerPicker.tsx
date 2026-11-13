/**
 * Choose the server the app talks to: WeldSuite cloud (Global), WeldSuite EU
 * (when the build knows its address) or a self-hosted server by address.
 * A server is checked before it is saved (`/config.json`, mobile sign-in,
 * the app's module); saving signs out and restarts the app on it
 * (`switchServer`, docs/plans/mobile-server-choice.md).
 */

import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  checkServerAddress,
  checkServerOrigin,
  hostOf,
  switchServer,
  type MobileAppIdentity,
  type ServerCheck,
  type ServerChoice,
  type ServerKind,
} from '@weldsuite/mobile-platform/runtime';
import { Sheet } from './Sheet';
import { Button } from './Button';
import { Input } from './Input';
import { useTheme } from '../contexts/ThemeContext';
import { Radii, Spacing } from '../constants/theme';
import { fillCopy, SERVER_COPY, type ServerCopy, type ServerLanguage } from '../constants/server-copy';

export interface ServerPickerProps {
  visible: boolean;
  onClose: () => void;
  app: MobileAppIdentity;
  /** The server the app runs against now. */
  current: ServerChoice;
  /** The EU origin this build knows; null hides the EU option. */
  euOrigin: string | null;
  language?: ServerLanguage;
  copy?: Partial<ServerCopy>;
  accentColor?: string;
  /** Ask before switching (signed in: switching signs out). @default true */
  confirm?: boolean;
  /** Accept http:// addresses (development builds only). */
  allowInsecure?: boolean;
}

export function serverCopy(language: ServerLanguage = 'en', copy?: Partial<ServerCopy>): ServerCopy {
  return { ...SERVER_COPY[language], ...copy };
}

/** Display name for a server: the product name, or the host for a self-hosted one. */
export function serverDisplayName(choice: ServerChoice, labels: ServerCopy): string {
  if (choice.kind === 'global') return labels.globalName;
  if (choice.kind === 'eu') return labels.euName;
  return choice.origin ? hostOf(choice.origin) : labels.selfHostedName;
}

/** Why a server can't be used, in words. */
export function serverProblemMessage(
  problem: Extract<ServerCheck, { ok: false }>['problem'],
  labels: ServerCopy,
  appName: string,
): string {
  switch (problem) {
    case 'invalid-address':
      return labels.invalidAddress;
    case 'insecure-address':
      return labels.insecureAddress;
    case 'unreachable':
      return labels.unreachable;
    case 'not-weldsuite':
      return labels.notWeldsuite;
    case 'no-mobile-sign-in':
      return labels.noMobileSignIn;
    case 'app-unavailable':
      return fillCopy(labels.appUnavailable, { app: appName });
  }
}

type CheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok'; origin: string; version: string | null }
  | { status: 'error'; message: string };

/** The options the picker shows: EU only when the build knows its address. */
function serverOptions(labels: ServerCopy, euOrigin: string | null): Array<{ kind: ServerKind; name: string; hint: string }> {
  const options: Array<{ kind: ServerKind; name: string; hint: string }> = [
    { kind: 'global', name: labels.globalName, hint: labels.globalHint },
  ];
  if (euOrigin) options.push({ kind: 'eu', name: labels.euName, hint: labels.euHint });
  options.push({ kind: 'self-hosted', name: labels.selfHostedName, hint: labels.selfHostedHint });
  return options;
}

/** "Use this server" is enabled for a new choice that's ready (a self-hosted one once checked). */
function canUseServer(kind: ServerKind, currentKind: ServerKind, check: CheckState, switching: boolean): boolean {
  if (switching || check.status === 'checking') return false;
  if (kind === 'self-hosted') return check.status === 'ok';
  return kind !== currentKind;
}

function sameServer(a: ServerChoice, b: ServerChoice): boolean {
  return a.kind === b.kind && (a.kind === 'global' || a.kind === 'eu' || a.origin === b.origin);
}

export function ServerPicker({
  visible,
  onClose,
  app,
  current,
  euOrigin,
  language = 'en',
  copy,
  accentColor = '#3B82F6',
  confirm = true,
  allowInsecure = false,
}: Readonly<ServerPickerProps>) {
  const { colors } = useTheme();
  const labels = serverCopy(language, copy);
  const [kind, setKind] = useState<ServerKind>(current.kind);
  const [address, setAddress] = useState(current.kind === 'self-hosted' && current.origin ? hostOf(current.origin) : '');
  const [check, setCheck] = useState<CheckState>({ status: 'idle' });
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setKind(current.kind);
    setCheck({ status: 'idle' });
    setSwitching(false);
  }, [visible, current.kind]);

  const options = serverOptions(labels, euOrigin);

  const showResult = (result: ServerCheck) => {
    if (result.ok) setCheck({ status: 'ok', origin: result.origin, version: result.config.version ?? null });
    else setCheck({ status: 'error', message: serverProblemMessage(result.problem, labels, app.name) });
    return result;
  };

  const onConnect = async () => {
    setCheck({ status: 'checking' });
    showResult(await checkServerAddress(address, app, { allowInsecure }));
  };

  const doSwitch = async (next: ServerChoice) => {
    setSwitching(true);
    try {
      await switchServer(next);
    } finally {
      // Only reached when the restart didn't happen.
      setSwitching(false);
    }
  };

  const onUse = async () => {
    let next: ServerChoice;
    if (kind === 'global') {
      next = { kind: 'global' };
    } else if (kind === 'eu') {
      if (!euOrigin) return;
      setCheck({ status: 'checking' });
      const result = showResult(await checkServerOrigin(euOrigin, app));
      if (!result.ok) return;
      next = { kind: 'eu', origin: euOrigin };
    } else {
      if (check.status !== 'ok') return;
      next = { kind: 'self-hosted', origin: check.origin };
    }
    if (sameServer(next, current)) {
      onClose();
      return;
    }
    if (!confirm) {
      await doSwitch(next);
      return;
    }
    Alert.alert(
      labels.switchTitle,
      fillCopy(labels.switchBody, { app: app.name, server: serverDisplayName(next, labels) }),
      [
        { text: labels.cancel, style: 'cancel' },
        { text: labels.switchConfirm, style: 'destructive', onPress: () => void doSwitch(next) },
      ],
    );
  };

  const canUse = canUseServer(kind, current.kind, check, switching);

  return (
    <Sheet visible={visible} onClose={onClose} title={labels.pickerTitle} heightRatio={0.75}>
      <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>{labels.pickerSubtitle}</Text>

      <View accessibilityRole="radiogroup" style={styles.options}>
        {options.map((option) => {
          const selected = option.kind === kind;
          return (
            <Pressable
              key={option.kind}
              testID={`server-option-${option.kind}`}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => {
                setKind(option.kind);
                setCheck({ status: 'idle' });
              }}
              style={[
                styles.option,
                { borderColor: selected ? accentColor : colors.border, backgroundColor: colors.cardBackground },
              ]}
            >
              <View style={[styles.radio, { borderColor: selected ? accentColor : colors.border }]}>
                {selected ? <View style={[styles.radioDot, { backgroundColor: accentColor }]} /> : null}
              </View>
              <View style={styles.optionText}>
                <Text style={[styles.optionName, { color: colors.text }]}>
                  {option.name}
                  {option.kind === current.kind ? (
                    <Text style={{ color: colors.mutedForeground }}>{`  · ${labels.current}`}</Text>
                  ) : null}
                </Text>
                <Text style={[styles.optionHint, { color: colors.mutedForeground }]}>{option.hint}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      {kind === 'self-hosted' ? (
        <View style={styles.address}>
          <Input
            testID="server-address"
            label={labels.addressLabel}
            placeholder={labels.addressPlaceholder}
            value={address}
            onChangeText={(text) => {
              setAddress(text);
              if (check.status !== 'checking') setCheck({ status: 'idle' });
            }}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType={Platform.OS === 'ios' ? 'url' : 'default'}
            textContentType="URL"
            returnKeyType="go"
            onSubmitEditing={() => void onConnect()}
            editable={!switching}
          />
          <Button
            testID="server-connect"
            title={check.status === 'checking' ? labels.checking : labels.connect}
            variant="secondary"
            onPress={() => void onConnect()}
            disabled={!address.trim() || check.status === 'checking' || switching}
          />
        </View>
      ) : null}

      {check.status === 'checking' ? (
        <View style={styles.status}>
          <ActivityIndicator color={colors.mutedForeground} />
          <Text style={[styles.statusText, { color: colors.mutedForeground }]}>{labels.checking}</Text>
        </View>
      ) : null}
      {check.status === 'ok' && kind === 'self-hosted' ? (
        <Text testID="server-found" style={[styles.statusText, { color: colors.success }]}>
          {fillCopy(labels.serverFound, { server: hostOf(check.origin), version: check.version ?? '?' })}
        </Text>
      ) : null}
      {check.status === 'error' ? (
        <Text testID="server-error" style={[styles.statusText, { color: colors.destructive }]}>
          {check.message}
        </Text>
      ) : null}

      <View style={styles.actions}>
        <Button
          testID="server-use"
          title={switching ? labels.switching : labels.useServer}
          loading={switching}
          onPress={() => void onUse()}
          disabled={!canUse}
          fullWidth
          style={{ backgroundColor: accentColor }}
        />
        <Button title={labels.cancel} variant="ghost" onPress={onClose} disabled={switching} fullWidth />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: Spacing.md,
  },
  options: {
    gap: Spacing.sm,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    padding: Spacing.md,
    borderWidth: 1.5,
    borderRadius: Radii.lg,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  optionText: {
    flex: 1,
  },
  optionName: {
    fontSize: 16,
    fontWeight: '600',
  },
  optionHint: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  address: {
    marginTop: Spacing.md,
    gap: Spacing.sm,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  statusText: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: Spacing.sm,
  },
  actions: {
    marginTop: Spacing.lg,
    gap: Spacing.sm,
  },
});
